// Local audit harness: serves a multi-page artifact with the REAL feedback
// widget injected, plus a stubbed /_au/comments API seeded to exercise the
// cases that matter (cross-page comments, resolved threads, replies, long
// content, long lists). No production side effects.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const KEY = "claims-demo-a1b2c3";
const BASE = `/go/${KEY}`;

// Inject the REAL widget source (apps/worker/src/widget/feedback.js) the same
// way serve.ts does: a config global + the widget script.
const WIDGET_SRC = readFileSync(
  path.resolve(import.meta.dirname, "../../src/widget/feedback.js"),
  "utf8",
);
const VERSION = "ver_current";
function injectWidget(html, art) {
  if (art.gate_level === "public") return html;
  const cfg = JSON.stringify({ artifactKey: art.url_key, versionId: VERSION });
  const script = `<script>window.__AU_FEEDBACK__=${cfg};</script><script>${WIDGET_SRC}</script>`;
  return html.includes("</body>")
    ? html.replace("</body>", `${script}</body>`)
    : `${html}${script}`;
}
const ART = { gate_level: "email", url_key: KEY };

const shell = (title, nav, main) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b2420;background:#f4f6f5}
header{background:#12383b;color:#fff;padding:14px 22px;display:flex;gap:18px;align-items:center}
header h1{font-size:16px;margin:0;font-weight:800}
nav{display:flex;gap:14px;margin-left:auto}nav a{color:#bfe0dd;text-decoration:none;font-weight:600;font-size:13px}nav a.on{color:#fff;border-bottom:2px solid #f3a712;padding-bottom:2px}
main{max-width:880px;margin:26px auto;padding:0 22px}
.card{background:#fff;border:1px solid #d8e0dd;border-radius:10px;padding:20px;margin:0 0 18px}
h2{font-size:20px;margin:0 0 10px}h3{margin:18px 0 8px}
button.cta{background:#12383b;color:#fff;border:0;border-radius:7px;padding:10px 16px;font-weight:700;cursor:pointer}
button.ghost{background:#eef4f2;color:#23312d;border:1px solid #cdd9d5;border-radius:7px;padding:9px 14px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6ece9}
.metric{display:inline-block;min-width:150px;padding:14px;border:1px solid #e0e7e4;border-radius:8px;margin:6px 8px 6px 0}
.metric b{display:block;font-size:26px;color:#12383b}.metric span{font-size:12px;color:#6a7a74}
.chart{height:200px;border-radius:8px;background:linear-gradient(180deg,#e8f3f0,#cfe6e1);display:flex;align-items:flex-end;gap:8px;padding:14px}
.chart i{flex:1;background:#12686d;border-radius:4px 4px 0 0}
img.exhibit{width:100%;max-width:420px;border-radius:8px;border:1px solid #d8e0dd}
.muted{color:#6a7a74}
</style></head><body>
<header><h1>Claims Audit Console</h1><nav>${nav}</nav></header>
<main>${main}</main></body></html>`;

const nav = (cur) =>
  [
    ["", "Overview"],
    ["/findings.html", "Findings"],
    ["/evidence.html", "Evidence"],
  ]
    .map(
      ([p, label]) =>
        `<a class="${cur === p ? "on" : ""}" href="${BASE}${p || "/"}">${label}</a>`,
    )
    .join("");

const pages = {
  "/": shell(
    "Overview — Claims Audit Console",
    nav(""),
    `<div class="card"><h2>Q2 Claims Review</h2>
      <p class="muted">Operations console for the disputed-claims batch. Run the audit, then review findings and evidence.</p>
      <p><button class="cta" id="run-audit">Run audit</button>
      <button class="ghost" id="export-csv">Export CSV</button></p></div>
    <div class="card"><h3>Batch status</h3>
      <table><thead><tr><th>Stage</th><th>Owner</th><th>State</th></tr></thead>
      <tbody><tr><td>Intake</td><td>A. Rao</td><td>Complete</td></tr>
      <tr><td>Triage</td><td>M. Lee</td><td>In review</td></tr>
      <tr><td id="release-row">Release</td><td>—</td><td>Blocked</td></tr></tbody></table></div>`,
  ),
  "/findings.html": shell(
    "Findings — Claims Audit Console",
    nav("/findings.html"),
    `<div class="card"><h2>Findings</h2>
      <div class="metric" id="total-exposure"><b>$2.4M</b><span>Total exposure</span></div>
      <div class="metric"><b>17</b><span>Flagged claims</span></div>
      <div class="metric"><b>4</b><span>High severity</span></div></div>
    <div class="card"><h3>Exposure by category</h3>
      <div class="chart" id="exposure-chart"><i style="height:40%"></i><i style="height:70%"></i><i style="height:55%"></i><i style="height:90%"></i><i style="height:30%"></i></div></div>`,
  ),
  "/resolve.html": shell(
    "Resolve — Claims Audit Console",
    nav("/resolve.html"),
    `<div class="card"><h2>Resolution ladder test</h2>
      <details id="acc"><summary>Collapsed section (click Locate to auto-open)</summary>
        <p id="hidden-target">Target inside a collapsed &lt;details&gt;.</p></details>
      <p id="display-none-target" style="display:none">Display-none target.</p></div>
    <div style="height:1500px" class="muted">— long spacer so the next element is off-screen on load —</div>
    <div class="card"><h3 id="far-down">Far-down heading (off-screen on load)</h3></div>`,
  ),
  "/stress.html": shell(
    "Stress — Claims Audit Console",
    nav("/stress.html"),
    `<div class="card"><h2 id="stress-title">Z-index / top-layer stress</h2>
      <p><button class="cta" id="open-dialog">Open modal dialog</button>
      <button class="ghost" id="go-fs">Fullscreen this card</button></p>
      <p class="muted">The feedback launcher must stay visible above the max z-index overlay, the modal dialog (top layer), and fullscreen.</p></div>
    <div id="zoverlay" style="position:fixed;inset:0;background:rgba(10,30,30,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800">
      Artifact overlay at z-index 2147483647 — launcher should still be clickable (bottom-right).</div>
    <dialog id="dlg" style="border:0;border-radius:12px;padding:24px;max-width:420px"><h3>Artifact modal (top layer)</h3>
      <p>The feedback launcher should render above this dialog.</p>
      <form method="dialog"><button class="cta">Close</button></form></dialog>
    <script>
      document.getElementById('open-dialog').onclick=function(){document.getElementById('dlg').showModal()};
      document.getElementById('go-fs').onclick=function(){document.getElementById('stress-title').closest('.card').requestFullscreen&&document.getElementById('stress-title').closest('.card').requestFullscreen()};
    </script>`,
  ),
  "/evidence.html": shell(
    "Evidence — Claims Audit Console",
    nav("/evidence.html"),
    `<div class="card"><h2>Evidence</h2>
      <h3 id="exhibit-b">Exhibit B — damage photo</h3>
      <img class="exhibit" id="exhibit-b-img" alt="Exhibit B damage photo" src="data:image/svg+xml;utf8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260"><rect width="420" height="260" fill="#dfeae7"/><text x="210" y="135" font-size="20" text-anchor="middle" fill="#5a6c66">Exhibit B</text></svg>',
      )}">
      <p class="muted">Submitted by claimant on 2026-05-18.</p></div>`,
  ),
};

// ---- seeded feedback ----
const t0 = 1_750_000_000;
const tj = (label, path, selector) =>
  JSON.stringify({
    selector,
    label,
    path,
    rect: { x: 40, y: 200, w: 160, h: 40 },
  });
let nextId = 100;
const comments = [
  {
    id: 1,
    parent_comment_id: null,
    email: "dana.reviewer@example.com",
    body: "The Run audit button should be disabled until intake completes.",
    target_json: tj("Run audit", `${BASE}/`, "#run-audit"),
    created_at: t0 + 10,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 2,
    parent_comment_id: null,
    email: "ops-lead@example.com",
    body: "Total exposure looks 200k too high vs the source ledger — please reconcile.",
    target_json: tj(
      "Total exposure",
      `${BASE}/findings.html`,
      "#total-exposure",
    ),
    created_at: t0 + 40,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 3,
    parent_comment_id: null,
    email: "dana.reviewer@example.com",
    body: "General note: the overall flow is clear, nice work.",
    target_json: null,
    created_at: t0 + 30,
    resolved_at: t0 + 200,
    resolved_by: "maria.manager@example.com",
  },
  {
    id: 4,
    parent_comment_id: 3,
    email: "maria.manager@example.com",
    body: "Agreed, resolving.",
    target_json: null,
    created_at: t0 + 210,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 5,
    parent_comment_id: null,
    email: "claims.auditor.longaddress@insurance-partner.example.com",
    body: "Exhibit B is low resolution; can we get the original 12MP capture? Hard to read the serial plate in the corner which matters for the severity call.",
    target_json: tj(
      "Exhibit B — damage photo",
      `${BASE}/evidence.html`,
      "#exhibit-b",
    ),
    created_at: t0 + 55,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 6,
    parent_comment_id: 5,
    email: "ops-lead@example.com",
    body: "Requested from claimant.",
    target_json: null,
    created_at: t0 + 60,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 7,
    parent_comment_id: 5,
    email: "dana.reviewer@example.com",
    body: "Thanks — will re-score once it lands.",
    target_json: null,
    created_at: t0 + 70,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 8,
    parent_comment_id: null,
    email: "m.lee@example.com",
    body: "Release row still shows Blocked — is that expected for this milestone?",
    target_json: tj("Release", `${BASE}/`, "#release-row"),
    created_at: t0 + 80,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 9,
    parent_comment_id: null,
    email: "a.rao@example.com",
    body: "Export CSV throws on empty batches.",
    target_json: tj("Export CSV", `${BASE}/`, "#export-csv"),
    created_at: t0 + 90,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 10,
    parent_comment_id: null,
    email: "ops-lead@example.com",
    body: "The exposure chart needs axis labels and a legend; right now I cannot tell which bar is which category.",
    target_json: tj(
      "Exposure by category",
      `${BASE}/findings.html`,
      "#exposure-chart",
    ),
    created_at: t0 + 100,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 11,
    parent_comment_id: null,
    email: "maria.manager@example.com",
    body: "Typo in the intro paragraph: 'disputed-claims batch'.",
    target_json: null,
    created_at: t0 + 110,
    resolved_at: t0 + 300,
    resolved_by: "maria.manager@example.com",
  },
  {
    id: 12,
    parent_comment_id: null,
    email: "dana.reviewer@example.com",
    body: "High severity count of 4 conflicts with the 5 shown in last week's export.",
    target_json: null,
    created_at: t0 + 120,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 13,
    parent_comment_id: null,
    email: "a.rao@example.com",
    body: "Mobile layout: the metric cards overflow horizontally below 360px.",
    target_json: null,
    created_at: t0 + 130,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 14,
    parent_comment_id: null,
    email: "m.lee@example.com",
    body: "Can we add a timestamp of when the audit was last run?",
    target_json: null,
    created_at: t0 + 140,
    resolved_at: null,
    resolved_by: null,
  },
  // resolution-ladder fixtures (page: /resolve.html)
  {
    id: 20,
    parent_comment_id: null,
    email: "qa@example.com",
    body: "Hidden inside a collapsed details — Locate should auto-open it.",
    target_json: JSON.stringify({
      selector: "#hidden-target",
      label: "Hidden target",
      path: `${BASE}/resolve.html`,
      rect: { x: 200, y: 150, w: 320, h: 24 },
    }),
    created_at: t0 + 160,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 21,
    parent_comment_id: null,
    email: "qa@example.com",
    body: "Targets a display:none element — should ghost at its last-known spot.",
    target_json: JSON.stringify({
      selector: "#display-none-target",
      label: "Display-none target",
      path: `${BASE}/resolve.html`,
      rect: { x: 200, y: 190, w: 280, h: 24 },
    }),
    created_at: t0 + 165,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 22,
    parent_comment_id: null,
    email: "qa@example.com",
    body: "Element was removed in a later version — ghost marker only.",
    target_json: JSON.stringify({
      selector: "#ghost-missing-xyz",
      label: "Removed widget",
      path: `${BASE}/resolve.html`,
      version_id: "ver_old",
      rect: { x: 220, y: 1650, w: 240, h: 44 },
    }),
    created_at: t0 + 170,
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: 23,
    parent_comment_id: null,
    email: "qa@example.com",
    body: "Far-down element — should smooth-scroll into view and pulse.",
    target_json: JSON.stringify({
      selector: "#far-down",
      label: "Far-down heading",
      path: `${BASE}/resolve.html`,
      rect: { x: 220, y: 1650, w: 240, h: 30 },
    }),
    created_at: t0 + 175,
    resolved_at: null,
    resolved_by: null,
  },
  // multi-anchor: selector is stale but the text anchor still resolves it.
  {
    id: 24,
    parent_comment_id: null,
    email: "qa@example.com",
    body: "Stale selector, but the text anchor should still find the heading.",
    target_json: JSON.stringify({
      v: 2,
      selector: "#renamed-xyz",
      label: "Far-down heading",
      path: `${BASE}/resolve.html`,
      anchors: [
        { type: "selector", value: "#renamed-xyz" },
        { type: "text", value: "Far-down heading (off-screen on load)" },
      ],
      rect: { x: 220, y: 1650, w: 240, h: 30 },
    }),
    created_at: t0 + 180,
    resolved_at: null,
    resolved_by: null,
  },
];

const send = (res, status, type, body) => {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;

  if (p === "/_au/comments") {
    const tjPath = (c) => {
      try {
        return c.target_json ? JSON.parse(c.target_json).path : null;
      } catch {
        return null;
      }
    };
    const tjVer = (c) => {
      try {
        return c.target_json ? JSON.parse(c.target_json).version_id : null;
      } catch {
        return null;
      }
    };
    if (req.method === "GET") {
      await new Promise((r) =>
        setTimeout(r, Number(process.env.AU_DELAY || 0)),
      ); // optional latency to exercise the loading state
      const out = comments.map((c) => ({
        ...c,
        page_path: c.page_path ?? tjPath(c) ?? null,
        version_id: c.version_id ?? tjVer(c) ?? null,
      }));
      return send(
        res,
        200,
        "application/json",
        JSON.stringify({ comments: out }),
      );
    }
    let raw = "";
    for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {};
    if (req.method === "POST") {
      comments.push({
        id: ++nextId,
        parent_comment_id: b.parent_id || null,
        email: "you@example.com",
        body: String(b.body || ""),
        target_json: b.target ? JSON.stringify(b.target) : null,
        page_path: b.page_path ?? (b.target && b.target.path) ?? null,
        version_id: b.version_id ?? null,
        created_at: t0 + 500 + nextId,
        resolved_at: null,
        resolved_by: null,
      });
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }
    if (req.method === "PATCH") {
      const c = comments.find((x) => x.id === Number(b.id));
      if (c && b.target !== undefined) {
        // re-anchor
        c.target_json = JSON.stringify(b.target);
        c.page_path = b.target && b.target.path;
        return send(
          res,
          200,
          "application/json",
          JSON.stringify({
            ok: true,
            comment: { id: c.id, target_json: c.target_json },
          }),
        );
      }
      if (c) {
        c.resolved_at = b.resolved !== false ? t0 + 900 : null;
        c.resolved_by = c.resolved_at ? "you@example.com" : null;
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }));
    }
  }

  // artifact pages
  if (p === BASE || p === `${BASE}/`)
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      injectWidget(pages["/"], ART),
    );
  const rel = p.startsWith(BASE + "/") ? p.slice(BASE.length) : null;
  if (rel && pages[rel])
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      injectWidget(pages[rel], ART),
    );

  send(res, 404, "text/plain", "not found");
});

server.listen(8799, "127.0.0.1", () =>
  console.log("audit harness on http://127.0.0.1:8799" + BASE + "/"),
);
