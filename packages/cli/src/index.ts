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
      html: { type: "string" },
      gate_level: {
        type: "string",
        enum: ["public", "email", "verified_email", "allowlist"],
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
  const conf = resolveConfig({
    apiBase: String(args.values["api-base"] || ""),
    token: String(args.values.token || ""),
  });
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
        `/api/v1/artifacts/${encodeURIComponent(String(input.artifact || ""))}`,
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
  throw new Error(`unknown command: ${command}`);
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
