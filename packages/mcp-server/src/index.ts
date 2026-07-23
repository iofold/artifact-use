#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  api,
  mimeFor,
  type PublishStart,
  publishFolder,
  resolveConfig,
  uploadFiles,
  validatePath,
} from "@artifact-use/client-core";
import {
  artifactCommentsTool,
  artifactManageTool,
  artifactPublishLocalTool,
  artifactUploadSessionTool,
} from "@artifact-use/client-core/schemas";

const baseConf = resolveConfig();

// Per-call workspace overrides the process-level pin (env or
// .artifact-use.json); the header rides on every request either way.
function confFor(
  args: Record<string, unknown>,
): ReturnType<typeof resolveConfig> {
  const workspace = String(args.workspace || "").trim();
  delete args.workspace;
  return workspace ? { ...baseConf, workspace } : baseConf;
}

const server = new Server(
  { name: "artifact-use", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    artifactPublishLocalTool,
    artifactUploadSessionTool,
    artifactManageTool,
    artifactCommentsTool,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  const conf = confFor(args);
  let result: unknown;
  if (name === "artifact_publish") {
    if (args.dir)
      result = await publishFolder(conf, args, Boolean(args.dry_run));
    else if (Array.isArray(args.files)) result = await publishFiles(conf, args);
    else if (typeof args.html === "string" && args.html.trim())
      result = await api(conf, "POST", "/api/v1/publish/html", args);
    else throw new Error("artifact_publish requires dir, html, or files");
  } else if (name === "artifact_manage") {
    result = await manageArtifact(conf, args);
  } else if (name === "artifact_comments") {
    result = await commentOnArtifact(conf, args);
  } else if (name === "artifact_upload_session") {
    result = await api(conf, "POST", "/api/v1/publish/upload-session", args);
  } else {
    throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());

async function manageArtifact(
  conf: ReturnType<typeof resolveConfig>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = String(args.action || "");
  if (action === "list") return api(conf, "GET", "/api/v1/artifacts");
  if (action === "workspaces") return api(conf, "GET", "/api/v1/workspaces");
  const artifact = String(args.artifact || "");
  if (!artifact)
    throw new Error(`artifact_manage ${action || "action"} requires artifact`);
  const artifactRef = encodeURIComponent(artifact);
  if (action === "stats")
    return api(conf, "GET", `/api/v1/artifacts/${artifactRef}/stats`);
  if (action === "set_access")
    return api(conf, "PATCH", `/api/v1/artifacts/${artifactRef}`, {
      gate_level: args.gate_level,
      allowlist: args.allowlist,
    });
  if (action === "set_preview")
    return api(conf, "PATCH", `/api/v1/artifacts/${artifactRef}`, {
      title: args.title,
      description: args.description,
    });
  if (action === "share_link")
    return api(
      conf,
      "POST",
      `/api/v1/artifacts/${artifactRef}/share-links`,
      args,
    );
  throw new Error(`unknown artifact_manage action: ${action}`);
}

async function commentOnArtifact(
  conf: ReturnType<typeof resolveConfig>,
  args: Record<string, unknown>,
): Promise<unknown> {
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
    return api(conf, "GET", q.size ? `${path}?${q}` : path);
  }
  if (action === "post")
    return api(conf, "POST", path, {
      body: args.body,
      parent_id: args.parent_id,
      page_path: args.page_path,
    });
  if (action === "resolve" || action === "reopen")
    return api(conf, "PATCH", path, {
      id: args.comment_id,
      resolved: action === "resolve",
    });
  throw new Error(`unknown artifact_comments action: ${action}`);
}

async function publishFiles(
  conf: ReturnType<typeof resolveConfig>,
  args: Record<string, unknown>,
): Promise<unknown> {
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
  const start = (await api(conf, "POST", "/api/v1/publish/start", {
    artifact: args.artifact,
    title: args.title,
    description: args.description,
    gate_level: args.gate_level || "email",
    entrypoint,
  })) as PublishStart;
  const total = normalized.reduce((sum, file) => sum + file.size, 0);
  if (
    normalized.length > start.limits.file_count ||
    total > start.limits.package_bytes
  )
    throw new Error("files exceed service limits");
  await uploadFiles(
    conf,
    start.version.id,
    start.limits.file_bytes,
    normalized.map((file) => ({
      path: file.path,
      content_type: file.content_type,
      size: file.size,
      sha256: file.sha256,
      readBytes: async () => file.bytes,
    })),
  );
  return api(conf, "POST", `/api/v1/publish/${start.version.id}/complete`, {
    entrypoint,
    files: normalized.map(({ bytes: _bytes, ...file }) => file),
  });
}
