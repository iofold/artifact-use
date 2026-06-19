import type { Creator, Env } from "./types";
import { handleAdminApi } from "./admin";
import { safeCreator } from "./auth";
import { getArtifactsForOrgSlug } from "./db";
import { handlePublish } from "./publish";
import { error, json } from "./util";

const TOOLS = [
  {
    name: "artifact_publish",
    description:
      "Publish or update a static artifact. Pass html for a single-file artifact, or files for a small inline multi-file artifact. If you can read files from a local filesystem and make HTTP requests from a shell, prefer artifact_upload_session so file bytes go directly over HTTP instead of through MCP/model context.",
    inputSchema: {
      type: "object",
      required: ["artifact"],
      properties: {
        tenant: {
          type: "string",
          description:
            "Optional. Omit to use the authenticated account's default tenant.",
        },
        artifact: { type: "string" },
        title: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        entrypoint: { type: "string", default: "index.html" },
        html: { type: "string" },
        files: {
          type: "array",
          description:
            "Inline files for multi-file artifacts. Use content for text or content_base64 for binary.",
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
    name: "artifact_upload_session",
    description:
      "Create a short-lived direct upload session for large files or folders. Use this when the agent has filesystem and shell/curl access: call this tool for a 6-hour bearer upload_token, then PUT file bytes directly to upload_base with Content-Length, Content-Type, and X-Artifact-Sha256, and POST the manifest to complete_url without embedding file contents in MCP arguments.",
    inputSchema: {
      type: "object",
      required: ["artifact"],
      properties: {
        tenant: {
          type: "string",
          description:
            "Optional. Omit to use the authenticated account's default tenant.",
        },
        artifact: { type: "string" },
        title: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        entrypoint: { type: "string", default: "index.html" },
        ttl_seconds: {
          type: "number",
          description: "Token lifetime in seconds. Maximum is 21600 (6 hours).",
          default: 21600,
        },
      },
    },
  },
  {
    name: "artifact_manage",
    description:
      "List artifacts, fetch stats, update access, or create a tracked share link.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["list", "stats", "set_access", "share_link"],
        },
        tenant: {
          type: "string",
          description:
            "Optional for stats, set_access, and share_link when artifact is unique in the authenticated account.",
        },
        artifact: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        allowlist: { type: "object" },
        recipient_email: { type: "string" },
        recipient_label: { type: "string" },
        expires_days: { type: "number" },
      },
    },
  },
];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const creator = await safeCreator(request, env);
  if (creator instanceof Response) return creator;
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
    const result = await callTool(request, env, creator, name, args);
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
  creator: Creator,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = {
    Authorization: request.headers.get("Authorization") || "",
    "Content-Type": "application/json",
  };
  if (name === "artifact_publish") {
    if (Array.isArray(args.files)) {
      return publishInlineFiles(request, env, headers, args);
    }
    if (typeof args.html !== "string" || !args.html.trim()) {
      throw new Error("artifact_publish requires html or files");
    }
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
  if (name === "artifact_upload_session") {
    const r = await handlePublish(
      new Request(new URL("/api/v1/publish/upload-session", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      }),
      env,
      "/api/v1/publish/upload-session",
    );
    return r.json();
  }
  if (name === "artifact_manage") {
    const action = String(args.action || "");
    if (action === "list") {
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
    let tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    if (!tenant || !artifact)
      if (!artifact) {
        throw new Error(
          `artifact_manage ${action || "action"} requires artifact`,
        );
      } else {
        const matches = await getArtifactsForOrgSlug(
          env,
          creator.orgId,
          artifact,
        );
        if (!matches.length)
          throw new Error(
            `artifact not found in authenticated account: ${artifact}`,
          );
        if (matches.length > 1)
          throw new Error(
            `multiple artifacts named ${artifact}; pass tenant explicitly`,
          );
        const existing = matches[0];
        if (!existing)
          throw new Error(
            `artifact not found in authenticated account: ${artifact}`,
          );
        tenant = existing.tenant_slug;
      }
    if (action === "set_access") {
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
    if (action === "share_link") {
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
    if (action === "stats") {
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
    throw new Error(`unknown artifact_manage action: ${action}`);
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
      "Content-Length": String(file.bytes.byteLength),
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
  const sliced = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
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
