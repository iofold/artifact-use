#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const target = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(".mcp.json");
const config = {
  mcpServers: {
    "artifact-use": {
      type: "http",
      url: `${process.env.ARTIFACT_USE_API_BASE || "https://artifacts.iofold.com"}/mcp`,
    },
  },
};

if (existsSync(target)) {
  throw new Error(
    `${target} already exists; merge integrations/codex.mcp.json manually`,
  );
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(config, null, 2) + "\n");

const claudeHint = join(homedir(), ".claude", "settings.json");
console.log(
  JSON.stringify(
    { ok: true, wrote: target, claude_settings_hint: claudeHint },
    null,
    2,
  ),
);
