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
  process.env.ARTIFACT_USE_API_BASE || "https://art-use.iofold.com"
).replace(/\/$/, "");
const TOKEN = process.env.ARTIFACT_USE_TOKEN || "";

const server = new Server(
  { name: "artifact-use", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "artifact_use_publish_folder",
      description:
        "Publish a local static folder to Artifact Use. Requires ARTIFACT_USE_TOKEN.",
      inputSchema: {
        type: "object",
        required: ["tenant", "artifact", "dir"],
        properties: {
          tenant: { type: "string" },
          artifact: { type: "string" },
          title: { type: "string" },
          dir: { type: "string" },
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
      name: "artifact_use_publish_html",
      description: "Publish a single HTML string to Artifact Use.",
      inputSchema: {
        type: "object",
        required: ["tenant", "artifact", "html"],
        properties: {
          tenant: { type: "string" },
          artifact: { type: "string" },
          title: { type: "string" },
          html: { type: "string" },
          gate_level: {
            type: "string",
            enum: ["public", "email", "verified_email", "allowlist"],
          },
        },
      },
    },
    {
      name: "artifact_use_list_artifacts",
      description: "List artifacts for the authenticated organization.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "artifact_use_get_stats",
      description: "Fetch stats for an artifact.",
      inputSchema: {
        type: "object",
        required: ["tenant", "artifact"],
        properties: {
          tenant: { type: "string" },
          artifact: { type: "string" },
        },
      },
    },
    {
      name: "artifact_use_create_share_link",
      description: "Create a tracked share link.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  let result: unknown;
  if (name === "artifact_use_publish_folder")
    result = await publishFolder(args);
  else if (name === "artifact_use_publish_html")
    result = await api("POST", "/api/v1/publish/html", args);
  else if (name === "artifact_use_list_artifacts")
    result = await api("GET", "/api/v1/artifacts");
  else if (name === "artifact_use_get_stats")
    result = await api(
      "GET",
      `/api/v1/artifacts/${args.tenant}/${args.artifact}/stats`,
    );
  else if (name === "artifact_use_create_share_link") {
    result = await api(
      "POST",
      `/api/v1/artifacts/${args.tenant}/${args.artifact}/share-links`,
      args,
    );
  } else {
    throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());

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
      `${API_BASE}/api/v1/publish/${start.version.id}/files/${f.path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": f.content_type,
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

async function walk(
  root: string,
): Promise<
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
        if (
          !rel ||
          rel.startsWith("/") ||
          rel.includes("..") ||
          rel.startsWith("_") ||
          rel.startsWith("cdn-cgi/")
        ) {
          throw new Error(`invalid artifact path: ${rel}`);
        }
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
