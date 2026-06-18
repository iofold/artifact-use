#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const repoServer = resolve(repoRoot, "packages/mcp-server/dist/index.js");
const repoSource = resolve(repoRoot, "packages/mcp-server/src/index.ts");
const repoTsx = resolve(repoRoot, "node_modules/.bin/tsx");

let command = "npx";
let args = ["-y", "@artifact-use/mcp-server"];
if (existsSync(repoServer)) {
  command = process.execPath;
  args = [repoServer];
} else if (existsSync(repoTsx) && existsSync(repoSource)) {
  command = repoTsx;
  args = [repoSource];
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ARTIFACT_USE_API_BASE:
      process.env.ARTIFACT_USE_API_BASE || "https://artifacts.iofold.com",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
