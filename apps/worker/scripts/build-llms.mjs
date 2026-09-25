// Renders docs/agent-guide.md (the single source for agent-facing docs) into
// src/llms.generated.ts, which the worker serves as /llms-full.txt and, from
// the blocks between <!-- llms.txt --> markers, as the short /llms.txt index.
// Run by wrangler [build] (dev + deploy) and by the worker's build/typecheck
// scripts. Deterministic output.
//
// The guide is written against the hosted deployment so it reads naturally on
// GitHub; the hosted base URL and artifact path prefix become tokens here and
// src/llms.ts substitutes the deployment's own values at request time.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOSTED_BASE = "https://artifacts.iofold.com";
const HOSTED_PREFIX = "/go";
export const BASE_TOKEN = "{{BASE}}";
export const PREFIX_TOKEN = "{{PREFIX}}";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const source = path.join(root, "docs", "agent-guide.md");
const out = path.resolve(import.meta.dirname, "..", "src", "llms.generated.ts");

const guide = readFileSync(source, "utf8");

const full = tokenize(stripBuildComment(guide));
const short = tokenize(shortBlocks(guide));

for (const [label, text] of [
  ["llms-full", full],
  ["llms", short],
]) {
  // A bare "/go/" that is not attached to the hosted base would survive the
  // substitution and be wrong on self-hosted deployments.
  if (/(^|[^}])\/go\//.test(text))
    throw new Error(
      `[build-llms] ${label}: write artifact URLs in full (${HOSTED_BASE}${HOSTED_PREFIX}/...) in docs/agent-guide.md`,
    );
  if (text.includes(HOSTED_BASE))
    throw new Error(`[build-llms] ${label}: unsubstituted hosted base URL`);
}

const header =
  "// AUTO-GENERATED from docs/agent-guide.md by " +
  "apps/worker/scripts/build-llms.mjs — do not edit; edit the markdown.\n" +
  "// {{BASE}} and {{PREFIX}} are substituted per deployment by src/llms.ts.\n";
const body =
  `export const BASE_TOKEN = ${JSON.stringify(BASE_TOKEN)};\n` +
  `export const PREFIX_TOKEN = ${JSON.stringify(PREFIX_TOKEN)};\n` +
  `export const AGENT_GUIDE_FULL = ${JSON.stringify(full)};\n` +
  `export const AGENT_GUIDE_SHORT = ${JSON.stringify(short)};\n`;

const next = header + body;
let prev = "";
try {
  prev = readFileSync(out, "utf8");
} catch {}
if (prev !== next) {
  writeFileSync(out, next);
  console.log(
    `[build-llms] wrote ${path.relative(process.cwd(), out)} (${full.length} + ${short.length} chars)`,
  );
} else {
  console.log("[build-llms] up to date");
}

// The leading HTML comment explains the file to repository readers only.
function stripBuildComment(text) {
  return text.replace(/^(# [^\n]+\n\n)<!--[\s\S]*?-->\n\n/, "$1");
}

// Concatenate the marked blocks, in order, without the markers.
function shortBlocks(text) {
  const blocks = [];
  const re = /<!-- llms\.txt -->\n([\s\S]*?)<!-- \/llms\.txt -->/g;
  for (let m = re.exec(text); m; m = re.exec(text)) blocks.push(m[1].trim());
  if (!blocks.length)
    throw new Error("[build-llms] no <!-- llms.txt --> blocks in the guide");
  return blocks.join("\n\n") + "\n";
}

function tokenize(text) {
  return text
    .split(`${HOSTED_BASE}${HOSTED_PREFIX}/`)
    .join(`${BASE_TOKEN}${PREFIX_TOKEN}/`)
    .split(HOSTED_BASE)
    .join(BASE_TOKEN)
    .replace(/<!-- \/?llms\.txt -->\n\n?/g, "");
}
