#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

type GateLevel = "public" | "email" | "verified_email" | "allowlist";

interface Config {
  apiBase: string;
  token: string;
}

interface ManifestFile {
  path: string;
  content_type: string;
  size: number;
  sha256: string;
  abs_path: string;
}

const SCHEMAS = {
  "publish-folder": {
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
    },
  },
  "publish-html": {
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
  gate: {
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
      title: { type: "string" },
    },
  },
  share: {
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
  stats: {
    type: "object",
    required: ["tenant", "artifact"],
    properties: { tenant: { type: "string" }, artifact: { type: "string" } },
  },
};

main().catch((e) => {
  console.error(
    JSON.stringify({
      error: { message: e instanceof Error ? e.message : String(e) },
    }),
  );
  process.exit(1);
});

async function main(): Promise<void> {
  const command = process.argv[2] || "help";
  const args = parseArgs({
    args: process.argv.slice(3),
    options: {
      json: { type: "string" },
      "api-base": { type: "string" },
      token: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const conf = config(
    String(args.values["api-base"] || ""),
    String(args.values.token || ""),
  );
  const input = args.values.json ? JSON.parse(String(args.values.json)) : {};

  if (command === "help")
    return output({
      commands: Object.keys(SCHEMAS).concat(["list", "schema"]),
    });
  if (command === "schema") {
    const name = args.positionals[0];
    return output(
      args.values.all || !name
        ? SCHEMAS
        : (SCHEMAS as Record<string, unknown>)[name] || null,
    );
  }
  if (command === "publish-folder")
    return output(
      await publishFolder(conf, input, Boolean(args.values["dry-run"])),
    );
  if (command === "publish-html")
    return output(await api(conf, "POST", "/api/v1/publish/html", input));
  if (command === "list")
    return output(await api(conf, "GET", "/api/v1/artifacts"));
  if (command === "gate") {
    return output(
      await api(
        conf,
        "PATCH",
        `/api/v1/artifacts/${input.tenant}/${input.artifact}`,
        {
          gate_level: input.gate_level,
          allowlist: input.allowlist,
          title: input.title,
        },
      ),
    );
  }
  if (command === "share")
    return output(
      await api(
        conf,
        "POST",
        `/api/v1/artifacts/${input.tenant}/${input.artifact}/share-links`,
        input,
      ),
    );
  if (command === "stats")
    return output(
      await api(
        conf,
        "GET",
        `/api/v1/artifacts/${input.tenant}/${input.artifact}/stats`,
      ),
    );
  throw new Error(`unknown command: ${command}`);
}

function config(apiBase: string, token: string): Config {
  return {
    apiBase: (
      apiBase ||
      process.env.ARTIFACT_USE_API_BASE ||
      "https://artifacts.iofold.com"
    ).replace(/\/$/, ""),
    token: token || process.env.ARTIFACT_USE_TOKEN || "",
  };
}

async function publishFolder(
  conf: Config,
  input: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  const dir = resolve(String(input.dir || ""));
  if (!dir) throw new Error("dir required");
  const manifestFiles = await walk(dir);
  const entrypoint = String(input.entrypoint || "index.html");
  if (!manifestFiles.some((f) => f.path === entrypoint))
    throw new Error(`entrypoint not found: ${entrypoint}`);
  const total = manifestFiles.reduce((sum, f) => sum + f.size, 0);
  const manifest = {
    entrypoint,
    files: manifestFiles.map(({ abs_path: _abs, ...f }) => f),
  };
  if (dryRun) {
    return {
      dry_run: true,
      tenant: input.tenant,
      artifact: input.artifact,
      title: input.title,
      gate_level: input.gate_level || "email",
      entrypoint,
      file_count: manifest.files.length,
      total_size: total,
      files: manifest.files,
    };
  }
  requireToken(conf);
  const start = (await api(conf, "POST", "/api/v1/publish/start", {
    tenant: input.tenant,
    artifact: input.artifact,
    title: input.title,
    gate_level: input.gate_level || "email",
    entrypoint,
  })) as {
    version: { id: string };
    limits: { package_bytes: number; file_bytes: number; file_count: number };
  };
  if (manifest.files.length > start.limits.file_count)
    throw new Error(
      `file count exceeds service limit: ${start.limits.file_count}`,
    );
  if (total > start.limits.package_bytes)
    throw new Error(
      `package size exceeds service limit: ${start.limits.package_bytes}`,
    );
  for (const f of manifestFiles) {
    if (f.size > start.limits.file_bytes)
      throw new Error(`file exceeds service limit: ${f.path}`);
    const bytes = await readFile(f.abs_path);
    const res = await fetch(
      `${conf.apiBase}/api/v1/publish/${start.version.id}/files/${encodePath(f.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${conf.token}`,
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
  return api(
    conf,
    "POST",
    `/api/v1/publish/${start.version.id}/complete`,
    manifest,
  );
}

async function api(
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
  const res = await fetch(conf.apiBase + path, {
    ...init,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return parsed;
}

function requireToken(conf: Config): void {
  if (!conf.token) throw new Error("ARTIFACT_USE_TOKEN is required");
}

async function walk(root: string): Promise<ManifestFile[]> {
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`);
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
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
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

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
