import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export type GateLevel = "public" | "email" | "verified_email" | "allowlist";

export interface Config {
  apiBase: string;
  token: string;
}

export interface ManifestFile {
  path: string;
  content_type: string;
  size: number;
  sha256: string;
  abs_path: string;
}

export interface PublishLimits {
  package_bytes: number;
  file_bytes: number;
  file_count: number;
}

export interface PublishStart {
  version: { id: string };
  limits: PublishLimits;
}

export interface UploadFile {
  path: string;
  content_type: string;
  size: number;
  sha256: string;
  readBytes: () => Promise<Buffer<ArrayBuffer>>;
}

export function resolveConfig(
  overrides: { apiBase?: string; token?: string } = {},
): Config {
  return {
    apiBase: (
      overrides.apiBase ||
      process.env.ARTIFACT_USE_API_BASE ||
      "https://artifacts.iofold.com"
    ).replace(/\/$/, ""),
    token: overrides.token || process.env.ARTIFACT_USE_TOKEN || "",
  };
}

export function requireToken(conf: Config): void {
  if (!conf.token) throw new Error("ARTIFACT_USE_TOKEN is required");
}

export async function api(
  conf: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  requireToken(conf);
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${conf.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(conf.apiBase + path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export function validatePath(path: string): void {
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

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function mimeFor(path: string): string {
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

export async function walk(root: string): Promise<ManifestFile[]> {
  if (!(await stat(root)).isDirectory())
    throw new Error(`not a directory: ${root}`);
  const out: ManifestFile[] = [];
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

// PUT each file's bytes to the upload endpoint. Callers pass the walk-time
// size/sha256 (used for headers) and a lazy byte reader so folder publishes can
// re-read from disk while inline publishes reuse in-memory buffers.
export async function uploadFiles(
  conf: Config,
  versionId: string,
  fileByteLimit: number,
  files: UploadFile[],
): Promise<void> {
  for (const file of files) {
    if (file.size > fileByteLimit)
      throw new Error(`file exceeds service limit: ${file.path}`);
    const bytes = await file.readBytes();
    const res = await fetch(
      `${conf.apiBase}/api/v1/publish/${versionId}/files/${encodePath(file.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${conf.token}`,
          "Content-Type": file.content_type,
          "Content-Length": String(file.size),
          "X-Artifact-Sha256": file.sha256,
        },
        body: bytes,
      },
    );
    if (!res.ok)
      throw new Error(
        `upload failed for ${file.path}: ${res.status} ${await res.text()}`,
      );
  }
}

export async function publishFolder(
  conf: Config,
  input: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  if (!input.dir) throw new Error("dir required");
  const dir = resolve(String(input.dir));
  const manifestFiles = await walk(dir);
  const entrypoint = String(input.entrypoint || "index.html");
  if (!manifestFiles.some((f) => f.path === entrypoint))
    throw new Error(`entrypoint not found: ${entrypoint}`);
  const total = manifestFiles.reduce((sum, f) => sum + f.size, 0);
  const files = manifestFiles.map(({ abs_path: _abs, ...f }) => f);
  if (dryRun)
    return {
      dry_run: true,
      artifact: input.artifact,
      title: input.title,
      description: input.description,
      gate_level: input.gate_level || "email",
      entrypoint,
      file_count: files.length,
      total_size: total,
      files,
    };
  requireToken(conf);
  const start = (await api(conf, "POST", "/api/v1/publish/start", {
    artifact: input.artifact,
    title: input.title,
    description: input.description,
    gate_level: input.gate_level || "email",
    entrypoint,
  })) as PublishStart;
  if (files.length > start.limits.file_count)
    throw new Error(
      `file count exceeds service limit: ${start.limits.file_count}`,
    );
  if (total > start.limits.package_bytes)
    throw new Error(
      `package size exceeds service limit: ${start.limits.package_bytes}`,
    );
  await uploadFiles(
    conf,
    start.version.id,
    start.limits.file_bytes,
    manifestFiles.map((f) => ({
      path: f.path,
      content_type: f.content_type,
      size: f.size,
      sha256: f.sha256,
      readBytes: () => readFile(f.abs_path),
    })),
  );
  return api(conf, "POST", `/api/v1/publish/${start.version.id}/complete`, {
    entrypoint,
    files,
  });
}
