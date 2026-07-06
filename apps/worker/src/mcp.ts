import type { Env } from "./types";
import {
  artifactManageTool,
  artifactPublishTool,
  artifactUploadSessionTool,
} from "@artifact-use/client-core/schemas";
import { handleAdminApi } from "./admin";
import { safeCreator } from "./auth";
import { handlePublish } from "./publish";
import { error, json, mimeFor, sha256Hex } from "./util";

// The hosted /mcp endpoint serves the base (HTTP) tool surface; the stdio
// server composes its local-only dir/dry_run inputs on top.
const TOOLS = [
  artifactPublishTool,
  artifactUploadSessionTool,
  artifactManageTool,
];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const auth = await safeCreator(request, env);
  if (auth instanceof Response) return auth;
  if (request.method === "GET")
    return json({ name: "artifact-use", transport: "streamable-http-minimal" });
  if (request.method !== "POST")
    return error(405, "method_not_allowed", "POST required");
  const body = (await request.json()) as {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = body.id ?? null;
  try {
    if (body.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "artifact-use", version: "0.1.0" },
        },
      });
    }
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (body.method !== "tools/call")
      return json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found" },
      });
    const params = body.params || {};
    const name = String(params.name || "");
    const args = (params.arguments || {}) as Record<string, unknown>;
    const result = await callTool(request, env, name, args);
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      },
    });
  } catch (e) {
    return json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: e instanceof Error ? e.message : "tool failed",
      },
    });
  }
}

type ApiHandler = (
  request: Request,
  env: Env,
  path: string,
) => Promise<Response>;

// The MCP tools are thin adapters over the HTTP API: build an internal Request
// and dispatch it straight to the route handler.
function callApi(
  request: Request,
  env: Env,
  handler: ApiHandler,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return handler(new Request(new URL(path, request.url), init), env, path);
}

async function callTool(
  request: Request,
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = {
    Authorization: request.headers.get("Authorization") || "",
    "Content-Type": "application/json",
  };
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
    return r.json();
  }
  if (name === "artifact_upload_session") {
    const r = await callApi(
      request,
      env,
      handlePublish,
      "/api/v1/publish/upload-session",
      postJson(args),
    );
    return r.json();
  }
  if (name === "artifact_manage") {
    const action = String(args.action || "");
    const artifact = String(args.artifact || "");
    if (action !== "list" && !artifact)
      throw new Error(
        `artifact_manage ${action || "action"} requires artifact`,
      );
    const ref = encodeURIComponent(artifact);
    const routes: Record<string, { path: string; init: RequestInit }> = {
      list: { path: "/api/v1/artifacts", init: { method: "GET", headers } },
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
      share_link: {
        path: `/api/v1/artifacts/${ref}/share-links`,
        init: postJson(args),
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
    return r.json();
  }
  throw new Error(`unknown tool: ${name}`);
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
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
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
