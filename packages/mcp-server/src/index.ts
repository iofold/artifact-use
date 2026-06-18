#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = (
  process.env.ARTIFACT_USE_API_BASE || "https://artifacts.iofold.com"
).replace(/\/$/, "");
const TOKEN = process.env.ARTIFACT_USE_TOKEN || "";

const server = new Server(
  { name: "artifact-use", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "artifact_publish",
      description:
        "Publish or update a static artifact. Use dir for local folders without sending file bytes through model context, html for single-file artifacts, or files for small inline multi-file artifacts. If you can read files and run curl from a shell, use artifact_upload_session for direct HTTP upload without embedding file bytes in MCP arguments.",
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
          dir: { type: "string" },
          html: { type: "string" },
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
          gate_level: {
            type: "string",
            enum: ["public", "email", "verified_email", "allowlist"],
          },
          entrypoint: { type: "string", default: "index.html" },
          dry_run: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "artifact_upload_session",
      description:
        "Create a 6-hour direct upload session. Use this when the agent has filesystem and shell/curl access: PUT file bytes directly to upload_base with the returned bearer upload_token, Content-Length, Content-Type, and X-Artifact-Sha256, then POST the manifest to complete_url.",
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
          ttl_seconds: { type: "number", default: 21600 },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  let result: unknown;
  if (name === "artifact_publish") {
    if (args.dir) result = await publishFolder(args);
    else if (Array.isArray(args.files)) result = await publishFiles(args);
    else if (typeof args.html === "string" && args.html.trim())
      result = await api("POST", "/api/v1/publish/html", args);
    else throw new Error("artifact_publish requires dir, html, or files");
  } else if (name === "artifact_manage") {
    result = await manageArtifact(args);
  } else if (name === "artifact_upload_session") {
    result = await api("POST", "/api/v1/publish/upload-session", args);
  } else {
    throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());

async function manageArtifact(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action || "");
  if (action === "list") return api("GET", "/api/v1/artifacts");
  let tenant = String(args.tenant || "");
  const artifact = String(args.artifact || "");
  if (!artifact)
    throw new Error(`artifact_manage ${action || "action"} requires artifact`);
  if (!tenant) {
    const listed = (await api("GET", "/api/v1/artifacts")) as {
      artifacts?: Array<{ slug: string; tenant_slug: string }>;
    };
    const match = (listed.artifacts || []).find((row) => row.slug === artifact);
    if (!match)
      throw new Error(
        `artifact not found in authenticated account: ${artifact}`,
      );
    tenant = match.tenant_slug;
  }
  if (action === "stats")
    return api("GET", `/api/v1/artifacts/${tenant}/${artifact}/stats`);
  if (action === "set_access")
    return api("PATCH", `/api/v1/artifacts/${tenant}/${artifact}`, {
      gate_level: args.gate_level,
      allowlist: args.allowlist,
    });
  if (action === "share_link")
    return api(
      "POST",
      `/api/v1/artifacts/${tenant}/${artifact}/share-links`,
      args,
    );
  throw new Error(`unknown artifact_manage action: ${action}`);
}

async function publishFiles(args: Record<string, unknown>): Promise<unknown> {
  const files = Array.isArray(args.files)
    ? (args.files as Array<Record<string, unknown>>)
    : [];
  if (!files.length) throw new Error("files array is required");
  const normalized = files.map((file) => {
    const path = String(file.path || "");
    validatePath(path);
    const bytes = file.content_base64
      ? Buffer.from(String(file.content_base64), "base64")
      : Buffer.from(String(file.content || ""), "utf8");
    return {
      path,
      bytes,
      content_type: String(file.content_type || mimeFor(path)),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const entrypoint = String(args.entrypoint || "index.html");
  if (!normalized.some((file) => file.path === entrypoint))
    throw new Error(`entrypoint not found: ${entrypoint}`);
  const start = (await api("POST", "/api/v1/publish/start", {
    tenant: args.tenant,
    artifact: args.artifact,
    title: args.title,
    gate_level: args.gate_level || "email",
    entrypoint,
  })) as {
    version: { id: string };
    limits: { package_bytes: number; file_bytes: number; file_count: number };
  };
  const total = normalized.reduce((sum, file) => sum + file.size, 0);
  if (
    normalized.length > start.limits.file_count ||
    total > start.limits.package_bytes
  )
    throw new Error("files exceed service limits");
  for (const file of normalized) {
    if (file.size > start.limits.file_bytes)
      throw new Error(`file exceeds service limit: ${file.path}`);
    const res = await fetch(
      `${API_BASE}/api/v1/publish/${start.version.id}/files/${encodePath(file.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": file.content_type,
          "Content-Length": String(file.size),
          "X-Artifact-Sha256": file.sha256,
        },
        body: file.bytes,
      },
    );
    if (!res.ok)
      throw new Error(
        `upload failed for ${file.path}: ${res.status} ${await res.text()}`,
      );
  }
  return api("POST", `/api/v1/publish/${start.version.id}/complete`, {
    entrypoint,
    files: normalized.map(({ bytes: _bytes, ...file }) => file),
  });
}

async function publishFolder(args: Record<string, unknown>): Promise<unknown> {
  const dir = resolve(String(args.dir || ""));
  const files = await walk(dir);
  const entrypoint = String(args.entrypoint || "index.html");
  if (!files.some((f) => f.path === entrypoint))
    throw new Error(`entrypoint not found: ${entrypoint}`);
  const manifest = {
    entrypoint,
    files: files.map(({ abs_path: _abs, ...f }) => f),
  };
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (args.dry_run)
    return {
      dry_run: true,
      entrypoint,
      file_count: files.length,
      total_size: total,
      files: manifest.files,
    };
  requireToken();
  const start = (await api("POST", "/api/v1/publish/start", {
    tenant: args.tenant,
    artifact: args.artifact,
    title: args.title,
    gate_level: args.gate_level || "email",
    entrypoint,
  })) as {
    version: { id: string };
    limits: { package_bytes: number; file_bytes: number; file_count: number };
  };
  if (
    files.length > start.limits.file_count ||
    total > start.limits.package_bytes
  )
    throw new Error("folder exceeds service limits");
  for (const f of files) {
    if (f.size > start.limits.file_bytes)
      throw new Error(`file exceeds service limit: ${f.path}`);
    const bytes = await readFile(f.abs_path);
    const res = await fetch(
      `${API_BASE}/api/v1/publish/${start.version.id}/files/${encodePath(f.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": f.content_type,
          "Content-Length": String(f.size),
          "X-Artifact-Sha256": f.sha256,
        },
        body: bytes,
      },
    );
    if (!res.ok)
      throw new Error(
        `upload failed for ${f.path}: ${res.status} ${await res.text()}`,
      );
  }
  return api("POST", `/api/v1/publish/${start.version.id}/complete`, manifest);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  requireToken();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, {
    ...init,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function requireToken(): void {
  if (!TOKEN) throw new Error("ARTIFACT_USE_TOKEN is required");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.startsWith("_") ||
    path.startsWith("cdn-cgi/")
  ) {
    throw new Error(`invalid artifact path: ${path}`);
  }
}

async function walk(root: string): Promise<
  Array<{
    path: string;
    content_type: string;
    size: number;
    sha256: string;
    abs_path: string;
  }>
> {
  if (!(await stat(root)).isDirectory())
    throw new Error(`not a directory: ${root}`);
  const out: Array<{
    path: string;
    content_type: string;
    size: number;
    sha256: string;
    abs_path: string;
  }> = [];
  async function visit(abs: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (
        entry.name === ".DS_Store" ||
        entry.name === "node_modules" ||
        entry.name === ".git"
      )
        continue;
      const child = resolve(abs, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const rel = relative(root, child).split(sep).join("/");
        validatePath(rel);
        const bytes = await readFile(child);
        out.push({
          path: rel,
          content_type: mimeFor(rel),
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          abs_path: child,
        });
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function mimeFor(path: string): string {
  const ext = basename(path).split(".").pop()?.toLowerCase() || "";
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
