#!/usr/bin/env node
// A deployment either isolates artifacts on their own hosts (wildcard DNS/TLS
// plus a route) or says by name that it serves them on the site origin.
// Neither one leaves uploaded pages inert and sandboxed, so refuse to deploy
// that by accident.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = process.argv[2] || "wrangler.toml";
const toml = readFileSync(resolve(base, config), "utf8");
const suffix =
  /^\s*ARTIFACT_HOST_SUFFIX\s*=\s*"([^"]*)"/m.exec(toml)?.[1].trim() || "";
const shared = /^\s*ARTIFACT_SHARED_ORIGIN\s*=\s*"true"/im.test(toml);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (suffix && shared)
  fail(
    "ARTIFACT_HOST_SUFFIX and ARTIFACT_SHARED_ORIGIN are both set. Remove ARTIFACT_SHARED_ORIGIN: the host suffix wins and artifacts run isolated.",
  );
if (!suffix && shared) {
  console.warn(
    `artifact origin: SHARED (${config}). Artifact pages run on the site origin, so a script in any artifact can act as the signed-in person who opens it. Set ARTIFACT_HOST_SUFFIX to isolate them; see docs/DEPLOY.md.`,
  );
  process.exit(0);
}
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(suffix))
  fail(
    'Set ARTIFACT_HOST_SUFFIX to a wildcard DNS/TLS domain before deploying, or ARTIFACT_SHARED_ORIGIN = "true" to keep artifacts on the site origin. See docs/DEPLOY.md.',
  );
if (!toml.includes(`*.${suffix}/*`))
  fail(`Add a worker route for *.${suffix}/* before deploying.`);
console.log(
  `artifact origin configuration ok (${config}); verify wildcard DNS/TLS before deployment`,
);
