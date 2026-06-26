// Publishes a 2-page email-gated artifact to the local wrangler-dev worker via
// the real publish API (start -> PUT files -> complete), using DEV_AUTH_TOKEN
// read from apps/worker/.dev.vars. See README.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.AU_BASE || "http://127.0.0.1:8788";
const devVars = readFileSync(
  path.resolve(import.meta.dirname, "../../.dev.vars"),
  "utf8",
);
const TOKEN = (devVars.match(/^DEV_AUTH_TOKEN=(.*)$/m) || [])[1]?.trim();
if (!TOKEN) throw new Error("DEV_AUTH_TOKEN not found in .dev.vars");
const auth = { Authorization: `Bearer ${TOKEN}` };

const page = (title, main) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;margin:0;color:#1b2420;background:#f4f6f5}header{background:#12383b;color:#fff;padding:14px 22px;display:flex;gap:16px}nav a{color:#bfe0dd;text-decoration:none;font-weight:600}main{max-width:820px;margin:24px auto;padding:0 22px}.card{background:#fff;border:1px solid #d8e0dd;border-radius:10px;padding:20px;margin-bottom:16px}button{background:#12383b;color:#fff;border:0;border-radius:7px;padding:10px 16px;font-weight:700}.metric{display:inline-block;min-width:150px;padding:14px;border:1px solid #e0e7e4;border-radius:8px}.metric b{display:block;font-size:26px;color:#12383b}</style></head>
<body><header><b>Claims Console</b><nav><a href="./">Overview</a> <a href="./findings.html">Findings</a></nav></header><main>${main}</main></body></html>`;

const files = {
  "index.html": page(
    "Overview",
    `<div class="card"><h2>Q2 Claims Review</h2><p>Operations console for the disputed-claims batch.</p>
      <p><button id="run-audit">Run audit</button> <button id="export-csv">Export CSV</button></p></div>`,
  ),
  "findings.html": page(
    "Findings",
    `<div class="card"><h2>Findings</h2><div class="metric" id="total-exposure"><b>$2.4M</b><span>Total exposure</span></div></div>`,
  ),
};

async function jx(method, p, body, extra = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...auth, ...extra },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const start = await jx(
  "POST",
  "/api/v1/publish/start",
  JSON.stringify({
    artifact: "staging-demo",
    title: "Staging Demo",
    gate_level: "email",
    entrypoint: "index.html",
  }),
  { "Content-Type": "application/json" },
);
const versionId = start.version.id;
const uploadBase = start.upload_base;
console.log("draft version:", versionId);

const manifestFiles = [];
for (const [rel, html] of Object.entries(files)) {
  const buf = Buffer.from(html, "utf8");
  const sha = createHash("sha256").update(buf).digest("hex");
  const r = await fetch(uploadBase + rel, {
    method: "PUT",
    headers: {
      ...auth,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(buf.byteLength),
      "X-Artifact-Sha256": sha,
    },
    body: buf,
  });
  if (!r.ok) throw new Error(`PUT ${rel} -> ${r.status}: ${await r.text()}`);
  manifestFiles.push({
    path: rel,
    content_type: "text/html; charset=utf-8",
    size: buf.byteLength,
  });
  console.log("uploaded:", rel);
}

await jx(
  "POST",
  `/api/v1/publish/${versionId}/complete`,
  JSON.stringify({ entrypoint: "index.html", files: manifestFiles }),
  { "Content-Type": "application/json" },
);
console.log("PUBLISHED url_key:", start.artifact.url_key);
console.log("PUBLIC PATH: /go/" + start.artifact.url_key + "/");
