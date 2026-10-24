#!/usr/bin/env node
// Deployment must configure wildcard DNS/TLS before enabling interactive
// artifact origins. Missing configuration serves inert, sandboxed documents.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = process.argv[2] || "wrangler.toml";
const toml = readFileSync(resolve(base, config), "utf8");
const suffix =
  /^\s*ARTIFACT_HOST_SUFFIX\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || "";
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(suffix)) {
  throw new Error(
    "Set ARTIFACT_HOST_SUFFIX to a wildcard DNS/TLS domain before deploying. See docs/DEPLOY.md.",
  );
}
if (!toml.includes(`*.${suffix}/*`)) {
  throw new Error(`Add a worker route for *.${suffix}/* before deploying.`);
}
console.log(
  `artifact origin configuration ok (${config}); verify wildcard DNS/TLS before deployment`,
);
