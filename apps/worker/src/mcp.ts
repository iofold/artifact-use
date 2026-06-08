import type { Env } from "./types";
import { handleAdminApi } from "./admin";
import { safeCreator } from "./auth";
import { handlePublish } from "./publish";
import { error, json } from "./util";

const TOOLS = [
  {
    name: "artifact_use_publish_html",
    description:
      "Publish a single HTML artifact to the authenticated WorkOS organization.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact", "html"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        title: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        html: { type: "string" },
      },
    },
  },
  {
    name: "artifact_use_publish_files",
    description:
      "Publish a small multi-file static artifact over HTTP MCP. Each file is sent inline as text or base64; use the CLI for large local folders.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact", "files"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        title: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        entrypoint: { type: "string", default: "index.html" },
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path"],
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              content_base64: { type: "string" },
              content_type: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "artifact_use_list_artifacts",
    description:
      "List artifacts visible to the authenticated WorkOS organization.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "artifact_use_set_gate",
    description: "Update an artifact gate level or allowlist.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact", "gate_level"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        allowlist: { type: "object" },
      },
    },
  },
  {
    name: "artifact_use_create_share_link",
    description: "Create a tracked share link for an artifact.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        recipient_email: { type: "string" },
        recipient_label: { type: "string" },
        expires_days: { type: "number" },
      },
    },
  },
  {
    name: "artifact_use_get_stats",
    description:
      "Fetch artifact views, unique viewers, share links, and recent visits.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact"],
      properties: { tenant: { type: "string" }, artifact: { type: "string" } },
    },
  },
];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
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
    const creator = await safeCreator(request, env);
    if (creator instanceof Response) return creator;
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
  if (name === "artifact_use_publish_html") {
    const r = await handlePublish(
      new Request(new URL("/api/v1/publish/html", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      }),
      env,
      "/api/v1/publish/html",
    );
    return r.json();
  }
  if (name === "artifact_use_publish_files") {
    return publishInlineFiles(request, env, headers, args);
  }
  if (name === "artifact_use_list_artifacts") {
    const r = await handleAdminApi(
      new Request(new URL("/api/v1/artifacts", request.url), {
        method: "GET",
        headers,
      }),
      env,
      "/api/v1/artifacts",
    );
    return r.json();
  }
  if (name === "artifact_use_set_gate") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(`/api/v1/artifacts/${tenant}/${artifact}`, request.url),
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            gate_level: args.gate_level,
            allowlist: args.allowlist,
          }),
        },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}`,
    );
    return r.json();
  }
  if (name === "artifact_use_create_share_link") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(
          `/api/v1/artifacts/${tenant}/${artifact}/share-links`,
          request.url,
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}/share-links`,
    );
    return r.json();
  }
  if (name === "artifact_use_get_stats") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(`/api/v1/artifacts/${tenant}/${artifact}/stats`, request.url),
        { method: "GET", headers },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}/stats`,
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
        contentType: String(file.content_type || contentTypeFor(path)),
        sha256: await sha256Hex(bytes),
      };
    }),
  );

  const start = (await readJsonOrThrow(
    await handlePublish(
      new Request(new URL("/api/v1/publish/start", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          tenant: args.tenant,
          artifact: args.artifact,
          title: args.title,
          gate_level: args.gate_level || "email",
          entrypoint: args.entrypoint || "index.html",
        }),
      }),
      env,
      "/api/v1/publish/start",
    ),
  )) as { version: { id: string } };

  for (const file of normalized) {
    const authHeader = headers.Authorization || "";
    const uploadHeaders = {
      Authorization: authHeader,
      "Content-Type": file.contentType,
      "X-Artifact-Sha256": file.sha256,
    };
    await readJsonOrThrow(
      await handlePublish(
        new Request(
          new URL(
            `/api/v1/publish/${start.version.id}/files/${encodePath(file.path)}`,
            request.url,
          ),
          {
            method: "PUT",
            headers: uploadHeaders,
            body: arrayBufferFor(file.bytes),
          },
        ),
        env,
        `/api/v1/publish/${start.version.id}/files/${file.path}`,
      ),
    );
  }

  return readJsonOrThrow(
    await handlePublish(
      new Request(
        new URL(`/api/v1/publish/${start.version.id}/complete`, request.url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            entrypoint: args.entrypoint || "index.html",
            files: normalized.map((file) => ({
              path: file.path,
              content_type: file.contentType,
              size: file.bytes.byteLength,
              sha256: file.sha256,
            })),
          }),
        },
      ),
      env,
      `/api/v1/publish/${start.version.id}/complete`,
    ),
  );
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferFor(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return sliced as ArrayBuffer;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const table: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
  };
  return table[ext] || "application/octet-stream";
}
