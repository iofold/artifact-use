import type { Creator, Env } from "./types";
import {
  artifactCommentsTool,
  artifactManageTool,
  artifactPublishTool,
  artifactUploadSessionTool,
} from "@artifact-use/client-core/schemas";
import { handleAdminApi } from "./admin";
import { safeCreator } from "./auth";
import {
  authKindFor,
  clientFromUserAgent,
  normalizeClientName,
  recordMcpEvent,
  type McpEventInput,
} from "./events";
import { handlePublish } from "./publish";
import { error, json, mimeFor, sha256Hex } from "./util";
import { WORKSPACE_HEADER } from "./workspaces";

// The hosted /mcp endpoint serves the base (HTTP) tool surface; the stdio
// server composes its local-only dir/dry_run inputs on top.
const TOOLS = [
  artifactPublishTool,
  artifactUploadSessionTool,
  artifactManageTool,
  artifactCommentsTool,
];

export const SERVER_INFO = { name: "artifact-use", version: "0.2.0" };
// Dual-era server (MCP 2026-07-28 "Versioning and Compatibility"): requests
// that carry per-request _meta are served statelessly under the modern
// revision; an `initialize` handshake selects legacy semantics.
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
export const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const INSTRUCTIONS =
  "Publish HTML or static folders to a stable, gated URL and read the comments viewers leave. Publish only when the user asks. To update an existing artifact, pass its url_key (from a previous publish or artifact_manage list) as `artifact`; a new slug creates a new artifact. Share the returned url with the user.";
// Tool definitions change with deploys, not per call; an hour is a safe cache.
const LIST_TTL_MS = 60 * 60 * 1000;

type RpcId = string | number | null;
interface RpcRequest {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

// Protocol-level failure (unknown tool, bad params): a JSON-RPC error.
class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// Tool execution failure: reported inside the result with isError so models
// stop mistaking a `{error}` payload for success.
export class ToolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function rpcResult(
  id: RpcId,
  result: Record<string, unknown>,
  modern: boolean,
  status = 200,
): Response {
  const body = modern
    ? {
        resultType: "complete",
        ...result,
        _meta: { [META_SERVER_INFO]: SERVER_INFO, ...(result._meta as object) },
      }
    : result;
  return json({ jsonrpc: "2.0", id, result: body }, { status });
}

function rpcFailure(
  id: RpcId,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
): Response {
  return json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { status },
  );
}

// `=?base64?...?=` sentinel encoding for header-unsafe names (spec §Value
// Encoding); plain values pass through.
function decodeHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const match = /^=\?base64\?(.*)\?=$/.exec(value.trim());
  if (!match) return value.trim();
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(match[1] || ""), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function validateModernRequest(
  request: Request,
  body: RpcRequest,
  meta: Record<string, unknown>,
  metaVersion: string,
): Response | null {
  const id = body.id ?? null;
  if (!MODERN_PROTOCOL_VERSIONS.includes(metaVersion))
    return rpcFailure(id, -32022, "Unsupported protocol version", 400, {
      supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS],
      requested: metaVersion,
    });
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (!headerVersion)
    return rpcFailure(
      id,
      -32020,
      "Header mismatch: MCP-Protocol-Version header is required",
      400,
    );
  if (headerVersion !== metaVersion)
    return rpcFailure(
      id,
      -32020,
      `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${metaVersion}'`,
      400,
    );
  const method = request.headers.get("Mcp-Method");
  if (!method || method !== body.method)
    return rpcFailure(
      id,
      -32020,
      method
        ? `Header mismatch: Mcp-Method header value '${method}' does not match body value '${body.method}'`
        : "Header mismatch: Mcp-Method header is required",
      400,
    );
  if (body.method === "tools/call") {
    const name = decodeHeaderValue(request.headers.get("Mcp-Name"));
    const bodyName = String(body.params?.name || "");
    if (!name || name !== bodyName)
      return rpcFailure(
        id,
        -32020,
        name
          ? `Header mismatch: Mcp-Name header value '${name}' does not match body value '${bodyName}'`
          : "Header mismatch: Mcp-Name header is required for tools/call",
        400,
      );
  }
  if (meta[META_CLIENT_CAPABILITIES] === undefined)
    return rpcFailure(
      id,
      -32602,
      `Invalid params: _meta['${META_CLIENT_CAPABILITIES}'] is required`,
      400,
    );
  return null;
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: MODERN_PROTOCOL_VERSIONS,
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    ttlMs: LIST_TTL_MS,
    cacheScope: "public",
  };
}

async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: string };
    };
    return body.error?.code || null;
  } catch {
    return null;
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  // No SSE stream and no sessions are offered at this endpoint, so GET and
  // DELETE are 405 before authentication (2026-07-28 §Earlier Streamable HTTP
  // Revisions). Answering 401 here sent Codex into an OAuth retry loop every
  // time it opened its stream: 3,232 GET 401s in one month.
  if (request.method !== "POST")
    return json(
      {
        error: {
          code: "method_not_allowed",
          message: "POST JSON-RPC to this endpoint; no SSE stream is offered",
        },
      },
      { status: 405, headers: { Allow: "POST, OPTIONS" } },
    );
  const userAgent = request.headers.get("User-Agent") || "";
  // Lax: the MCP envelope only authenticates identity. Workspace selection
  // arrives per tool call (args.workspace) and is enforced by the API routes
  // each tool dispatches to.
  const auth = await safeCreator(request, env, { laxWorkspace: true });
  const creator = auth instanceof Response ? null : auth;
  let body: RpcRequest;
  try {
    body = (await request.json()) as RpcRequest;
  } catch {
    return rpcFailure(null, -32700, "Parse error", 400);
  }
  const method = String(body.method || "");
  const params = (body.params || {}) as Record<string, unknown>;
  const meta = ((params._meta as Record<string, unknown>) || {}) as Record<
    string,
    unknown
  >;
  const metaVersion =
    typeof meta[META_VERSION] === "string"
      ? (meta[META_VERSION] as string)
      : null;
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const modern =
    metaVersion !== null ||
    (headerVersion !== null &&
      MODERN_PROTOCOL_VERSIONS.includes(headerVersion));
  const clientInfo =
    (meta[META_CLIENT_INFO] as { name?: unknown; version?: unknown }) ||
    (method === "initialize"
      ? (params.clientInfo as { name?: unknown; version?: unknown })
      : undefined);
  const fromUa = clientFromUserAgent(userAgent);
  const event: McpEventInput = {
    creator,
    authKind: authKindFor(creator),
    client:
      clientInfo && typeof clientInfo.name === "string"
        ? normalizeClientName(clientInfo.name)
        : fromUa.client,
    clientVersion:
      clientInfo && typeof clientInfo.version === "string"
        ? clientInfo.version.slice(0, 40)
        : fromUa.version,
    userAgent,
    protocolVersion:
      metaVersion ||
      headerVersion ||
      (method === "initialize" && typeof params.protocolVersion === "string"
        ? (params.protocolVersion as string)
        : null),
    method: method || "(none)",
    tool: method === "tools/call" ? String(params.name || "") : null,
    action:
      method === "tools/call" &&
      params.arguments &&
      typeof (params.arguments as Record<string, unknown>).action === "string"
        ? String((params.arguments as Record<string, unknown>).action)
        : null,
    ok: true,
    durationMs: 0,
  };
  const finish = async (response: Response): Promise<Response> => {
    event.durationMs = Date.now() - startedAt;
    if (!event.ok || response.status >= 400) {
      event.ok = false;
      event.status = event.status ?? response.status;
      event.errorCode = event.errorCode ?? (await errorCodeOf(response));
    }
    await recordMcpEvent(env, event);
    return response;
  };

  if (auth instanceof Response) return finish(auth);
  const id = body.id ?? null;
  // Notifications carry no id and expect no body.
  if (body.id === undefined || body.id === null) {
    if (method.startsWith("notifications/"))
      return finish(new Response(null, { status: 202 }));
  }
  if (modern) {
    const invalid = validateModernRequest(
      request,
      body,
      meta,
      metaVersion || headerVersion || "",
    );
    if (invalid) return finish(invalid);
  }

  try {
    if (method === "server/discover")
      return finish(rpcResult(id, discoverResult(), true));
    if (method === "initialize") {
      const requested = String(params.protocolVersion || "");
      return finish(
        rpcResult(
          id,
          {
            protocolVersion: LEGACY_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
          false,
        ),
      );
    }
    if (method === "ping") return finish(rpcResult(id, {}, modern));
    if (method === "tools/list")
      return finish(
        rpcResult(
          id,
          modern
            ? { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: "private" }
            : { tools: TOOLS },
          modern,
        ),
      );
    if (method !== "tools/call")
      return finish(rpcFailure(id, -32601, "Method not found"));
    const name = String(params.name || "");
    const args = { ...((params.arguments || {}) as Record<string, unknown>) };
    if (!creator) return finish(error(401, "unauthorized", "unauthorized"));
    try {
      const result = await callTool(request, env, creator, name, args);
      return finish(
        rpcResult(
          id,
          {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          },
          modern,
        ),
      );
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const failure =
        e instanceof ToolError
          ? e
          : new ToolError(
              "invalid_arguments",
              e instanceof Error ? e.message : "tool failed",
              400,
            );
      event.ok = false;
      event.status = failure.status;
      event.errorCode = failure.code;
      const structured = {
        error: {
          code: failure.code,
          message: failure.message,
          status: failure.status,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        },
      };
      return finish(
        rpcResult(
          id,
          {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(structured, null, 2) },
            ],
            structuredContent: structured,
          },
          modern,
        ),
      );
    }
  } catch (e) {
    if (e instanceof RpcError)
      return finish(rpcFailure(id, e.code, e.message, 200, e.data));
    event.ok = false;
    event.status = 500;
    event.errorCode = "internal_error";
    return finish(
      rpcFailure(id, -32000, e instanceof Error ? e.message : "tool failed"),
    );
  }
}

type ApiHandler = (
  request: Request,
  env: Env,
  path: string,
) => Promise<Response>;

// The MCP tools are thin adapters over the HTTP API: build an internal Request
// and dispatch it straight to the route handler. `query` rides only on the
// Request URL — route matching happens on the bare `path`.
function callApi(
  request: Request,
  env: Env,
  handler: ApiHandler,
  path: string,
  init: RequestInit,
  query = "",
): Promise<Response> {
  return handler(
    new Request(new URL(path + query, request.url), init),
    env,
    path,
  );
}

async function callTool(
  request: Request,
  env: Env,
  _creator: Creator,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const workspace = String(args.workspace || "").trim();
  delete args.workspace;
  const headers: Record<string, string> = {
    Authorization: request.headers.get("Authorization") || "",
    "Content-Type": "application/json",
  };
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  const postJson = (body: unknown) => postJsonInit(headers, body);
  if (name === "artifact_publish") {
    if (Array.isArray(args.files)) {
      return publishInlineFiles(request, env, headers, args);
    }
    if (typeof args.html !== "string" || !args.html.trim()) {
      throw new Error("artifact_publish requires html or files");
    }
    const r = await callApi(
      request,
      env,
      handlePublish,
      "/api/v1/publish/html",
      postJson(args),
    );
    return toolResponse(r);
  }
  if (name === "artifact_upload_session") {
    const r = await callApi(
      request,
      env,
      handlePublish,
      "/api/v1/publish/upload-session",
      postJson(args),
    );
    return toolResponse(r);
  }
  if (name === "artifact_manage") {
    const action = String(args.action || "");
    const artifact = String(args.artifact || "");
    if (action !== "list" && action !== "workspaces" && !artifact)
      throw new Error(
        `artifact_manage ${action || "action"} requires artifact`,
      );
    if (action === "delete" && args.confirm !== true)
      throw new Error(
        "artifact_manage delete permanently removes the artifact with every version, file, share link, comment, and view record; pass confirm: true to proceed",
      );
    const ref = encodeURIComponent(artifact);
    const routes: Record<string, { path: string; init: RequestInit }> = {
      list: { path: "/api/v1/artifacts", init: { method: "GET", headers } },
      workspaces: {
        path: "/api/v1/workspaces",
        init: { method: "GET", headers },
      },
      stats: {
        path: `/api/v1/artifacts/${ref}/stats`,
        init: { method: "GET", headers },
      },
      set_access: {
        path: `/api/v1/artifacts/${ref}`,
        init: {
          ...postJson({
            gate_level: args.gate_level,
            allowlist: args.allowlist,
          }),
          method: "PATCH",
        },
      },
      set_preview: {
        path: `/api/v1/artifacts/${ref}`,
        init: {
          ...postJson({
            title: args.title,
            description: args.description,
          }),
          method: "PATCH",
        },
      },
      set_upstream: {
        path: `/api/v1/artifacts/${ref}`,
        init: {
          ...postJson({ upstream: upstreamPatch(args) }),
          method: "PATCH",
        },
      },
      share_link: {
        path: `/api/v1/artifacts/${ref}/share-links`,
        init: postJson(args),
      },
      delete: {
        path: `/api/v1/artifacts/${ref}`,
        init: { method: "DELETE", headers },
      },
      move: {
        path: `/api/v1/artifacts/${ref}/move`,
        init: postJson({ workspace: args.to_workspace }),
      },
    };
    const route = routes[action];
    if (!route) throw new Error(`unknown artifact_manage action: ${action}`);
    const r = await callApi(
      request,
      env,
      handleAdminApi,
      route.path,
      route.init,
    );
    return toolResponse(r);
  }
  if (name === "artifact_comments") {
    const action = String(args.action || "");
    const artifact = String(args.artifact || "");
    if (!artifact) throw new Error("artifact_comments requires artifact");
    const path = `/api/v1/artifacts/${encodeURIComponent(artifact)}/comments`;
    if (action === "list") {
      const q = new URLSearchParams();
      for (const key of ["status", "since", "page_path", "limit"] as const) {
        if (args[key] !== undefined && args[key] !== null && args[key] !== "")
          q.set(key, String(args[key]));
      }
      const r = await callApi(
        request,
        env,
        handleAdminApi,
        path,
        { method: "GET", headers },
        q.size ? `?${q}` : "",
      );
      return toolResponse(r);
    }
    if (action === "post") {
      const r = await callApi(
        request,
        env,
        handleAdminApi,
        path,
        postJson({
          body: args.body,
          parent_id: args.parent_id,
          page_path: args.page_path,
        }),
      );
      return toolResponse(r);
    }
    if (action === "resolve" || action === "reopen") {
      const r = await callApi(request, env, handleAdminApi, path, {
        ...postJson({ id: args.comment_id, resolved: action === "resolve" }),
        method: "PATCH",
      });
      return toolResponse(r);
    }
    throw new Error(`unknown artifact_comments action: ${action}`);
  }
  throw new RpcError(-32602, `unknown tool: ${name}`);
}

// API responses come back as-is on success; a non-2xx becomes a ToolError so
// the caller sees isError instead of a success envelope wrapping `{error}`.
async function toolResponse(response: Response): Promise<unknown> {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  if (response.ok) return body;
  throw new ToolError(
    body.error?.code || "request_failed",
    body.error?.message || `request failed with status ${response.status}`,
    response.status,
    body,
  );
}

// `upstream_url` set -> replace the artifact's upstream backend (secret
// optional); empty/absent -> clear it.
function upstreamPatch(
  args: Record<string, unknown>,
): { base_url: string; secret: string | null } | null {
  const baseUrl = String(args.upstream_url || "").trim();
  if (!baseUrl) return null;
  const secret = String(args.upstream_secret || "").trim();
  return { base_url: baseUrl, secret: secret || null };
}

async function publishInlineFiles(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const files = Array.isArray(args.files)
    ? (args.files as Array<Record<string, unknown>>)
    : [];
  if (!files.length) throw new Error("files array is required");
  const limit = Number(env.HTTP_MCP_INLINE_FILE_LIMIT_BYTES || "2097152");
  const normalized = await Promise.all(
    files.map(async (file) => {
      const path = String(file.path || "");
      const bytes = file.content_base64
        ? decodeBase64(String(file.content_base64))
        : new TextEncoder().encode(String(file.content || ""));
      if (bytes.byteLength > limit)
        throw new Error(`inline MCP file exceeds ${limit} bytes: ${path}`);
      return {
        path,
        bytes,
        contentType: String(file.content_type || mimeFor(path)),
        sha256: await sha256Hex(bytes),
      };
    }),
  );

  const start = (await readJsonOrThrow(
    await callApi(
      request,
      env,
      handlePublish,
      "/api/v1/publish/start",
      postJsonInit(headers, {
        artifact: args.artifact,
        title: args.title,
        description: args.description,
        gate_level: args.gate_level,
        entrypoint: args.entrypoint || "index.html",
      }),
    ),
  )) as { version: { id: string } };

  for (const file of normalized) {
    // The raw path is used for both the URL and the route match; encoding it
    // would make the stored path diverge for names with literal %XX sequences.
    await readJsonOrThrow(
      await callApi(
        request,
        env,
        handlePublish,
        `/api/v1/publish/${start.version.id}/files/${file.path}`,
        {
          method: "PUT",
          headers: {
            Authorization: headers.Authorization || "",
            "Content-Type": file.contentType,
            "Content-Length": String(file.bytes.byteLength),
            "X-Artifact-Sha256": file.sha256,
          },
          body: arrayBufferFor(file.bytes),
        },
      ),
    );
  }

  return readJsonOrThrow(
    await callApi(
      request,
      env,
      handlePublish,
      `/api/v1/publish/${start.version.id}/complete`,
      postJsonInit(headers, {
        entrypoint: args.entrypoint || "index.html",
        files: normalized.map((file) => ({
          path: file.path,
          content_type: file.contentType,
          size: file.bytes.byteLength,
          sha256: file.sha256,
        })),
      }),
    ),
  );
}

function postJsonInit(
  headers: Record<string, string>,
  body: unknown,
): RequestInit {
  return { method: "POST", headers, body: JSON.stringify(body) };
}

async function readJsonOrThrow(response: Response): Promise<unknown> {
  return toolResponse(response);
}

function decodeBase64(value: string): Uint8Array {
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  const sliced = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return sliced as ArrayBuffer;
}
