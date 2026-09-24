#!/usr/bin/env node
// Refuse to deploy a configuration whose legal-policy URLs point at this
// worker's own /legal/ pages when the (gitignored) static files are missing.
// On 2026-09-09 a deploy from a fresh checkout shipped without
// public/legal/*.html and /legal/terms and /legal/privacy returned 404 for two
// weeks while search engines crawled them.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..");
const config = process.argv[2] || "wrangler.toml";
const toml = readFileSync(join(worker, config), "utf8");

function tomlVar(name) {
  const match = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
}

const base = tomlVar("SITE_BASE_URL").replace(/\/$/, "");
const missing = [];
for (const name of ["ARTIFACT_USE_PRIVACY_URL", "ARTIFACT_USE_TERMS_URL"]) {
  const url = tomlVar(name);
  if (!base || !url.startsWith(`${base}/legal/`)) continue;
  const page = url.slice(`${base}/legal/`.length).replace(/\/$/, "");
  const file = join(worker, "public", "legal", `${page}.html`);
  if (!existsSync(file)) missing.push(`${name} -> ${file}`);
}
if (missing.length) {
  console.error(
    `Legal policy pages are configured but their static files are missing:\n  ${missing.join("\n  ")}\nRestore apps/worker/public/legal/*.html (they are gitignored) before deploying.`,
  );
  process.exit(1);
}
console.log(`legal assets ok (${config})`);
