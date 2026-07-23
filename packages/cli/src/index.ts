#!/usr/bin/env node
import { parseArgs } from "node:util";
import { api, publishFolder, resolveConfig } from "@artifact-use/client-core";

const SCHEMAS = {
  "publish-folder": {
    type: "object",
    required: ["artifact", "dir"],
    properties: {
      artifact: { type: "string" },
      title: { type: "string" },
      description: { type: "string", maxLength: 200 },
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
    required: ["artifact", "html"],
    properties: {
      artifact: { type: "string" },
      title: { type: "string" },
      description: { type: "string", maxLength: 200 },
      html: { type: "string" },
      gate_level: {
        type: "string",
        enum: ["public", "email", "verified_email", "allowlist"],
      },
    },
  },
  preview: {
    type: "object",
    required: ["artifact"],
    properties: {
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
      title: { type: "string" },
      description: {
        type: "string",
        maxLength: 200,
        description:
          "Public link-preview summary; visible even when the artifact is gated.",
      },
    },
  },
  gate: {
    type: "object",
    required: ["artifact", "gate_level"],
    properties: {
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
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
    required: ["artifact"],
    properties: {
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
      recipient_email: { type: "string" },
      recipient_label: { type: "string" },
      expires_days: { type: "number" },
    },
  },
  stats: {
    type: "object",
    required: ["artifact"],
    properties: {
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
    },
  },
  comments: {
    type: "object",
    required: ["artifact"],
    properties: {
      artifact: {
        type: "string",
        description: "Artifact url_key from list output, or artifact slug.",
      },
      action: {
        type: "string",
        enum: ["list", "post", "resolve", "reopen"],
        default: "list",
      },
      status: {
        type: "string",
        enum: ["open", "resolved", "all"],
        description: "list: filter threads by resolution state.",
      },
      since: {
        type: "number",
        description: "list: only comments created after this unix timestamp.",
      },
      page_path: { type: "string" },
      limit: { type: "number" },
      body: { type: "string", description: "post: the comment text." },
      parent_id: {
        type: "number",
        description: "post: comment id to reply to.",
      },
      comment_id: {
        type: "number",
        description: "resolve/reopen: id of the comment (thread root).",
      },
    },
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
      workspace: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const conf = resolveConfig({
    apiBase: String(args.values["api-base"] || ""),
    token: String(args.values.token || ""),
    workspace: String(args.values.workspace || ""),
  });
  const input = args.values.json ? JSON.parse(String(args.values.json)) : {};

  if (command === "help")
    return output({
      commands: Object.keys(SCHEMAS).concat(["list", "workspaces", "schema"]),
      workspace:
        'multi-workspace tokens: pass --workspace <org id or slug>, set ARTIFACT_USE_WORKSPACE, or pin a project with .artifact-use.json {"workspace": "..."}; list yours with the workspaces command',
    });
  if (command === "workspaces")
    return output(await api(conf, "GET", "/api/v1/workspaces"));
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
        `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}`,
        {
          gate_level: input.gate_level,
          allowlist: input.allowlist,
          title: input.title,
        },
      ),
    );
  }
  if (command === "preview") {
    return output(
      await api(
        conf,
        "PATCH",
        `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}`,
        { title: input.title, description: input.description },
      ),
    );
  }
  if (command === "share")
    return output(
      await api(
        conf,
        "POST",
        `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}/share-links`,
        input,
      ),
    );
  if (command === "stats")
    return output(
      await api(
        conf,
        "GET",
        `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}/stats`,
      ),
    );
  if (command === "comments") return output(await comments(conf, input));
  throw new Error(`unknown command: ${command}`);
}

async function comments(
  conf: ReturnType<typeof resolveConfig>,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = String(input.action || "list");
  const path = `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}/comments`;
  if (action === "list") {
    const q = new URLSearchParams();
    for (const key of ["status", "since", "page_path", "limit"] as const) {
      if (input[key] !== undefined && input[key] !== null && input[key] !== "")
        q.set(key, String(input[key]));
    }
    return api(conf, "GET", q.size ? `${path}?${q}` : path);
  }
  if (action === "post")
    return api(conf, "POST", path, {
      body: input.body,
      parent_id: input.parent_id,
      page_path: input.page_path,
    });
  if (action === "resolve" || action === "reopen")
    return api(conf, "PATCH", path, {
      id: input.comment_id,
      resolved: action === "resolve",
    });
  throw new Error(`unknown comments action: ${action}`);
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
