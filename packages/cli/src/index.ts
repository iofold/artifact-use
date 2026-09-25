#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { api, publishFolder, resolveConfig } from "artifact-use-core";

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
      allow_secrets: { type: "boolean" },
      base_version_id: { type: "string" },
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
      allow_secrets: {
        type: "boolean",
        description:
          "Publish even when the HTML contains what look like credentials (the server otherwise refuses with secrets_detected).",
      },
      base_version_id: { type: "string" },
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

// One-line summaries for the usage text, in display order. Commands with a
// JSON input also appear in SCHEMAS; the rest take no --json.
const SUMMARIES: Record<string, string> = {
  "publish-html":
    "Publish one HTML page as an artifact; pass the url_key as artifact to republish.",
  "publish-folder":
    "Publish a local folder; --dry-run prints the manifest without uploading.",
  list: "List the workspace's artifacts.",
  stats: "View counts and gate statistics for an artifact.",
  gate: "Change who can open an artifact (gate level and allowlist).",
  preview: "Set the public title and link-preview description.",
  share: "Create a tracked share link for one recipient.",
  comments: "List, post, resolve, or reopen reviewer comments.",
  workspaces: "List the workspaces this token can publish to.",
  schema: "Print a command's JSON input schema; --all prints every schema.",
  help: "Print this usage; help <command> prints that command's JSON schema.",
};

const HELP_FLAGS = new Set(["help", "--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

main().catch((e) => {
  console.error(
    JSON.stringify({
      error: { message: e instanceof Error ? e.message : String(e) },
    }),
  );
  process.exit(1);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] || "help";
  // Help and version are the only human-first outputs; every real command
  // stays JSON on stdout so shells and agents can pipe it.
  if (VERSION_FLAGS.has(command)) return print(`${packageVersion()}\n`);
  if (HELP_FLAGS.has(command)) return help(argv[1]);
  if (argv.slice(1).some((arg) => HELP_FLAGS.has(arg) && arg !== "help"))
    return help(command);
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
  print(`${JSON.stringify(value, null, 2)}\n`);
}

function print(text: string): void {
  process.stdout.write(text);
}

// `help` alone prints the usage; `help <command>` (or `<command> --help`)
// prints that command's JSON input schema so an agent can fill it in.
function help(name: string | undefined): void {
  if (!name) return print(usage());
  if (!(name in SUMMARIES)) throw new Error(`unknown command: ${name}`);
  const schema = (SCHEMAS as Record<string, unknown>)[name];
  return output(
    schema || { type: "object", properties: {}, description: SUMMARIES[name] },
  );
}

function usage(): string {
  const width = Math.max(...Object.keys(SUMMARIES).map((n) => n.length)) + 4;
  const lines = [
    "Usage: artifact-use <command> [--json '<input object>'] [options]",
    "",
    "Publish HTML and static folders as stable, gated, reviewable links, then",
    "manage access, share links, stats, and reviewer comments.",
    "",
    "Commands (input fields: required, then [optional]):",
  ];
  for (const [name, summary] of Object.entries(SUMMARIES)) {
    lines.push(`  ${name.padEnd(width)}${fieldSummary(name)}`);
    lines.push(`  ${"".padEnd(width)}${summary}`);
  }
  lines.push("", "Values:");
  for (const [label, values] of enumValues())
    lines.push(`  ${label.padEnd(width)}${values}`);
  lines.push(
    "",
    "Options:",
    "  --json '<object>'      input fields for the command, as one JSON object",
    "  --workspace <id|slug>  target workspace for user-scoped tokens",
    "  --api-base <url>       API base URL (default https://artifacts.iofold.com)",
    "  --token <token>        creator token (mint one at <api base>/admin/connect)",
    "  --dry-run              publish-folder: print the manifest without uploading",
    "  --all                  schema: print every command's schema",
    "  --version, -v          print the CLI version",
    "  --help, -h             print this usage; <command> --help prints its schema",
    "",
    "Environment:",
    "  ARTIFACT_USE_TOKEN       creator token (--token overrides)",
    "  ARTIFACT_USE_API_BASE    API base URL (--api-base overrides)",
    "  ARTIFACT_USE_WORKSPACE   workspace for user-scoped tokens (--workspace",
    '                           overrides; .artifact-use.json {"workspace": "..."}',
    "                           pins a project)",
    "",
    "Output: every command prints one JSON document on stdout. Failures print",
    '{"error":{"message":...}} on stderr and exit 1.',
    "",
  );
  return lines.join("\n");
}

function fieldSummary(name: string): string {
  const schema = (SCHEMAS as Record<string, CommandSchema>)[name];
  if (!schema) {
    if (name === "schema") return "[command] [--all]";
    return name === "help" ? "[command]" : "(no input)";
  }
  const required = schema.required || [];
  const optional = Object.keys(schema.properties).filter(
    (key) => !required.includes(key),
  );
  return [
    required.join(", "),
    optional.length ? `[${optional.join(", ")}]` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

// Every enum in SCHEMAS, keyed by the bare field name when several commands
// share its values and by command.field otherwise.
function enumValues(): Array<[string, string]> {
  const byField = new Map<string, Map<string, string[]>>();
  for (const [name, schema] of Object.entries(SCHEMAS) as Array<
    [string, CommandSchema]
  >) {
    for (const [field, prop] of Object.entries(schema.properties)) {
      if (!Array.isArray(prop.enum)) continue;
      const values = prop.enum.map((value) =>
        value === prop.default ? `${value} (default)` : String(value),
      );
      const commands = byField.get(field) || new Map<string, string[]>();
      commands.set(name, values);
      byField.set(field, commands);
    }
  }
  const rows: Array<[string, string]> = [];
  for (const [field, commands] of byField) {
    const distinct = new Set([...commands.values()].map((v) => v.join("|")));
    if (distinct.size === 1 && commands.size > 1)
      rows.push([field, [...commands.values()][0]!.join(" | ")]);
    else
      for (const [name, values] of commands)
        rows.push([`${name}.${field}`, values.join(" | ")]);
  }
  return rows;
}

interface CommandSchema {
  required?: string[];
  properties: Record<string, { enum?: unknown[]; default?: unknown }>;
}

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}
