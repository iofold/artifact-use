import type {
  Artifact,
  Creator,
  Env,
  GateLevel,
  PublisherSession,
} from "./types";
import { abuseMailbox, abuseMailto } from "./abuse";
import {
  expireAdminCsrfCookie,
  extractStringArray,
  fromBase64Url,
  issueAdminCsrfToken,
  mintCreatorToken,
  readCookie,
  signPayload,
  userScopedOrgId,
  verifyAdminCsrf,
  verifyPayload,
} from "./auth";
import {
  approveConnectRequest,
  pendingConnectRequest,
  normalizeUserCode,
} from "./connect";
import { agentSetupPrompt } from "./llms";
import {
  stringClaim,
  workosApi,
  workosApiMaybe,
  WorkosApiError,
} from "./workos";
import { createShareLink, updateArtifactAccess } from "./db";
import { moderateArtifact, moderateOrganization } from "./moderation";
import {
  artifactUrlCode,
  artifactPathPrefix,
  error,
  escapeHtml,
  GATE_LEVELS,
  json,
  normalizeEmail,
  nowSec,
  publicArtifactPath,
  publicArtifactUrl,
  randomId,
  siteBaseUrl,
  slugify,
  SYSTEM_SECURITY_HEADERS,
  wantsHtml,
} from "./util";

const SESSION_COOKIE = "au_pub";
const STATE_COOKIE = "au_state";
const INVITE_COOKIE = "au_invite";
const NEXT_COOKIE = "au_next";
const TEAM_ADMIN_ROLES = new Set(["admin", "owner"]);
const TEAM_MANAGE_PERMISSIONS = new Set([
  "artifacts:admin",
  "team:manage",
  "organization_memberships:write",
]);
const TEAM_ROLE_OPTIONS = ["member", "admin"];

type ArtifactRow = Artifact & {
  total_views: number;
  unique_viewers: number;
  share_links: number;
  comment_count: number;
  open_comments: number;
  last_view_ts: number | null;
  file_count: number | null;
  total_size: number | null;
  completed_at: number | null;
};

type AdminRecentView = {
  artifact_id: string;
  slug: string;
  url_key: string;
  title: string;
  email: string;
  verified: number;
  ts: number;
  referrer: string | null;
};

type AdminShareLink = {
  id: string;
  artifact_id: string;
  recipient_email: string | null;
  recipient_label: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  view_count: number;
};

type AdminComment = {
  id: number;
  artifact_id: string;
  parent_comment_id: number | null;
  email: string;
  body: string;
  created_at: number;
  resolved_at: number | null;
};

type AdminDailyView = {
  artifact_id: string;
  day: string;
  n: number;
};

// Org-wide activity powers the chart, the 7d column, and the recent feed.
// Share links and comments are only needed for the one artifact whose sheet
// is open, so they are fetched per-artifact instead of org-wide.
type AdminMaps = {
  recent: Map<string, AdminRecentView[]>;
  daily: Map<string, AdminDailyView[]>;
};

type WorkosUser = {
  id?: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
};

type WorkosRole = {
  slug?: string;
};

type WorkosMembership = {
  id: string;
  user_id: string;
  organization_id: string;
  organization_name?: string;
  status: string;
  role?: WorkosRole;
  roles?: WorkosRole[];
  user?: WorkosUser;
  created_at?: string;
  updated_at?: string;
};

type WorkosInvitation = {
  id: string;
  email: string;
  state: string;
  organization_id?: string;
  inviter_user_id?: string | null;
  accepted_user_id?: string | null;
  role_slug?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  accepted_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

type WorkosTeam = {
  members: WorkosMembership[];
  invitations: WorkosInvitation[];
  error: string | null;
};

const GITHUB_URL = "https://github.com/iofold/artifact-use";

// Docs live as a published artifact when the deployment sets
// ARTIFACT_USE_DOCS_URL (dogfooding); the repo README is the fallback.
function docsUrl(env: Env): string {
  return env.ARTIFACT_USE_DOCS_URL || GITHUB_URL;
}

// Landing-page showcase artifacts and demo footage. Deployment-specific
// url_keys: replace with your own published artifacts (or empty the list)
// on other deployments. The videos live in a published showcase-media
// artifact — the platform hosts its own marketing footage.
const MEDIA_BASE = "/go/showcase-media-51ac21/";
const SHOWCASE = [
  {
    title: "Data Playground",
    desc: "Paste CSV or JSON, get sortable tables, column stats, and charts. Your data stays in the tab; a share link carries it in the URL.",
    tags: ["single file", "localStorage", "URL state", "zero deps"],
    path: "/go/data-playground-925c11/",
    video: "data-playground",
  },
  {
    title: "Fractal Lab",
    desc: "A Mandelbrot explorer whose math runs in a 267-byte hand-written WebAssembly module — with an honest JS-vs-WASM benchmark.",
    tags: ["WebAssembly", "canvas", "benchmark"],
    path: "/go/fractal-lab-0ce938/",
    video: "fractal-lab",
  },
  {
    title: "Product Pulse",
    desc: "A multi-file dashboard — ES modules, JSON data files, dependency-free SVG charts, dark mode — that lists its own manifest via the machine API.",
    tags: ["multi-file", "data viz", "self-describing"],
    path: "/go/product-pulse-1676b8/",
    video: "product-pulse",
  },
];

export async function renderHome(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getPublisherSession(request, env);
  if (session) return redirect("/admin");
  const base = siteBaseUrl(env);
  const prefix = artifactPathPrefix(env) || "";
  return page(
    "Artifact Use — publish agent output as review-ready links",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav>
        ${env.ARTIFACT_USE_DOCS_URL ? `<a href="${escapeHtml(env.ARTIFACT_USE_DOCS_URL)}">Docs</a>` : ""}
        <a href="${GITHUB_URL}">GitHub</a>
        <a href="/llms.txt">For agents</a>
        <a href="/login">Sign in</a>
        <a class="button small" href="/signup">Sign up</a>
      </nav>
    </header>
    <main class="home">
      <section class="hero">
        <div>
          <p class="eyebrow rise">Review-ready artifact links</p>
          <h1 class="rise d1">Turn agent output into links people can open and review.</h1>
          <p class="lead rise d2">Your coding agent publishes HTML tools, dashboards, PDFs, and whole static folders to one stable URL — gates, versions, and comments built in. Feedback comes back machine-readable, so the next agent ships v2 to the same link.</p>
          <div class="actions rise d3">
            <a class="button" href="/signup">Start publishing</a>
            <a class="button ghost" href="/llms.txt">Connect your agent</a>
          </div>
        </div>
        <div class="term rise d2" role="img" aria-label="A coding agent publishing an artifact and getting a stable link back">
          <div class="term-bar"><i></i><i></i><i></i><span>agent session</span></div>
          <pre><span class="t-dim"># your agent, at the end of a task</span>
&gt; artifact_publish { title: "Claims audit console", dir: "dist/" }

<span class="t-ok">published</span>  12 files · v3 · gate: email
<span class="t-url">${escapeHtml(base + prefix)}/claims-audit-console-4fk2a9/</span>

<span class="t-dim"># teammates open it and comment on it;</span>
<span class="t-dim"># the next agent reads the feedback</span><span class="caret"></span></pre>
        </div>
      </section>
      <section class="loop" aria-label="The feedback loop">
        <div class="loop-flow" aria-hidden="true">
          <svg viewBox="0 0 1140 230" preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id="loopFadeG" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#000"/>
                <stop offset="0.07" stop-color="#fff"/>
                <stop offset="0.93" stop-color="#fff"/>
                <stop offset="1" stop-color="#000"/>
              </linearGradient>
              <mask id="loopFade">
                <rect x="0" y="0" width="100%" height="100%" fill="url(#loopFadeG)"/>
              </mask>
            </defs>
            <g mask="url(#loopFade)">
            <path id="loopPath" d="M 8 158 C 170 70, 320 44, 465 74 C 585 99, 645 168, 588 196 C 538 220, 480 168, 525 118 C 585 52, 730 30, 866 48 C 985 64, 1055 92, 1134 74" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-dasharray="3 8" stroke-linecap="round"/>
            <text id="loopMeasure" class="loop-ribbon" opacity="0" x="-9999" y="-9999"></text>
            <text class="loop-ribbon"><textPath id="loopTP" href="#loopPath"></textPath></text>
            </g>
          </svg>
        </div></div>
        <div class="loop-head">
          <p class="eyebrow">The loop</p>
          <h2>Ship v1. The loop ships v2.</h2>
          <p class="muted">Artifacts aren't dead files. Colleagues comment right on the page, agents read that feedback over the API, apply it, and republish to the same link. Both reels below are real footage of real product actions.</p>
        </div>
        <figure class="story">
          <figcaption class="story-copy">
            <p class="eyebrow">Reel 01 · 36s</p>
            <h3>Your agent closes the loop.</h3>
            <p>Recorded live: a Claude Code session turns three colleague comments into a shipped v2 — no copy-paste, no redeploy, no new link.</p>
            <ul class="story-steps">
              <li>Reviewer clicks "Get your agent to read this"</li>
              <li>The agent pulls the artifact and its comments over the API</li>
              <li>Feedback applied, v2 republished from the terminal</li>
              <li>The reviewers' link now serves v2 — comments resolved</li>
            </ul>
          </figcaption>
          <div class="vid"><video data-autoplay src="${MEDIA_BASE}agent-loop.mp4" poster="${MEDIA_BASE}agent-loop.jpg" muted loop playsinline preload="none"></video></div>
        </figure>
        <figure class="story flip">
          <figcaption class="story-copy">
            <p class="eyebrow">Reel 02 · 22s</p>
            <h3>Feedback lives on the page.</h3>
            <p>A production spec out for review: colleagues comment directly on the artifact, so feedback stays threaded, anchored, and resolvable.</p>
            <ul class="story-steps">
              <li>Open the link — no account, no tool to install</li>
              <li>Comments anchor to elements on the page</li>
              <li>A one-time email keeps threads attributable</li>
              <li>Resolve and reopen right where the work happened</li>
            </ul>
          </figcaption>
          <div class="vid"><video data-autoplay src="${MEDIA_BASE}review-flow.mp4" poster="${MEDIA_BASE}review-flow.jpg" muted loop playsinline preload="none"></video></div>
        </figure>
      </section>
      <section class="feat" aria-label="What you get">
        <div class="feat-head">
          <p class="eyebrow">What you get</p>
          <h2>Everything an artifact needs, built in.</h2>
        </div>
        <div class="frow">
          <span class="fnum">01</span>
          <div class="fcopy"><strong>Stable links</strong><span>${escapeHtml(prefix)}/{slug}-{code}/ URLs that survive every republish — reviewers keep one link while versions advance.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <rect class="db" x="8" y="10" width="34" height="18" rx="9"/><text class="dl" x="25" y="22" text-anchor="middle">v1</text>
      <rect class="db" x="8" y="39" width="34" height="18" rx="9"/><text class="dl" x="25" y="51" text-anchor="middle">v2</text>
      <rect class="da" x="8" y="68" width="34" height="18" rx="9"/><text class="dw9" x="25" y="80" text-anchor="middle">v3</text>
      <path class="dd" d="M46 19 C 70 19, 80 42, 100 45"/>
      <path class="dd" d="M46 48 L 100 48"/>
      <path class="dd" d="M46 77 C 70 77, 80 54, 100 51"/>
      <rect class="db" x="104" y="36" width="108" height="24" rx="12"/>
      <text class="dlk" x="158" y="51" text-anchor="middle">/go/spec-4fk2a9/</text>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">02</span>
          <div class="fcopy"><strong>Access gates</strong><span>Public, email, verified email, or per-domain and per-address allowlists — set per artifact at publish time.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <rect class="db" x="8" y="26" width="44" height="34" rx="6"/>
      <path class="dln" d="M16 36 h 28 M16 44 h 20 M16 52 h 24"/>
      <path class="dd" d="M52 43 H 86"/>
      <rect class="db" x="86" y="21" width="44" height="44" rx="9"/>
      <circle cx="108" cy="38" r="5" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      <path d="M108 43 v 8" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/>
      <path class="dd" d="M130 43 H 164"/>
      <circle class="db" cx="182" cy="34" r="9"/>
      <path class="db" d="M168 62 c 0 -10, 28 -10, 28 0 v 2 h -28 z"/>
      <text class="dl" x="108" y="88" text-anchor="middle">public · email · allowlist</text>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">03</span>
          <div class="fcopy"><strong>Feedback</strong><span>Comments with element anchors, replies, and resolve/reopen — on the artifact itself.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <rect class="db" x="8" y="12" width="92" height="72" rx="7"/>
      <path class="dln" d="M18 26 h 60 M18 38 h 44 M18 50 h 56 M18 62 h 36"/>
      <circle class="da" cx="74" cy="50" r="8"/><text class="dw9" x="74" y="53.5" text-anchor="middle">1</text>
      <path class="dd" d="M82 50 C 96 50, 100 42, 112 40"/>
      <rect class="db" x="112" y="20" width="100" height="38" rx="8"/>
      <path class="dln" d="M122 32 h 64 M122 42 h 48"/>
      <rect class="da" x="112" y="66" width="72" height="18" rx="9"/>
      <text class="dw9" x="148" y="78" text-anchor="middle">resolved ✓</text>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">04</span>
          <div class="fcopy"><strong>Agent-first API</strong><span>HTTP MCP with OAuth or bearer tokens, a JSON-first CLI, and machine descriptors for every artifact.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <rect class="db" x="8" y="8" width="204" height="54" rx="8"/>
      <circle cx="20" cy="19" r="2.5" fill="var(--accent)"/><circle cx="29" cy="19" r="2.5" fill="var(--line)"/><circle cx="38" cy="19" r="2.5" fill="var(--line)"/>
      <text class="dt" x="18" y="40" fill="var(--ink)">$ au publish ./dist</text>
      <text class="dt" x="18" y="53" fill="var(--accent)">→ v4 live · same URL</text>
      <rect class="db" x="8" y="70" width="40" height="17" rx="8"/><text class="dl" x="28" y="81.5" text-anchor="middle">MCP</text>
      <rect class="db" x="54" y="70" width="40" height="17" rx="8"/><text class="dl" x="74" y="81.5" text-anchor="middle">CLI</text>
      <rect class="db" x="100" y="70" width="112" height="17" rx="8"/><text class="dl" x="156" y="81.5" text-anchor="middle">JSON descriptors</text>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">05</span>
          <div class="fcopy"><strong>Your infrastructure</strong><span>MIT licensed; runs on your Cloudflare account with R2 and D1. Agents never hold Cloudflare credentials.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <text class="dl" x="10" y="13">your cloudflare account</text>
      <rect x="8" y="20" width="148" height="64" rx="9" fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="4 4"/>
      <rect class="db" x="18" y="34" width="44" height="30" rx="6"/><text class="dl" x="40" y="52" text-anchor="middle">Worker</text>
      <rect class="db" x="68" y="34" width="36" height="30" rx="6"/><text class="dl" x="86" y="52" text-anchor="middle">R2</text>
      <rect class="db" x="110" y="34" width="36" height="30" rx="6"/><text class="dl" x="128" y="52" text-anchor="middle">D1</text>
      <text class="dl" x="18" y="78">MIT licensed</text>
      <rect class="da" x="166" y="43" width="46" height="18" rx="9"/><text class="dw9" x="189" y="55" text-anchor="middle">yours</text>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">06</span>
          <div class="fcopy"><strong>Team workspaces</strong><span>Invite teammates — everyone shares the same artifact list, stats, and feedback.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <circle class="db" cx="30" cy="40" r="12"/>
      <circle class="db" cx="50" cy="40" r="12"/>
      <circle class="db" cx="70" cy="40" r="12"/>
      <text class="dl" x="50" y="68" text-anchor="middle">one workspace</text>
      <path class="dd" d="M88 40 H 112"/>
      <rect class="db" x="112" y="14" width="100" height="68" rx="8"/>
      <path class="dln" d="M122 30 h 56 M122 48 h 64 M122 66 h 48"/>
      <circle class="da" cx="200" cy="30" r="3"/><circle class="da" cx="200" cy="48" r="3"/><circle cx="200" cy="66" r="3" fill="var(--line)"/>
    </svg></div>
        </div>
        <div class="frow">
          <span class="fnum">07</span>
          <div class="fcopy"><strong>Model- and harness-agnostic</strong><span>Your artifacts belong to you, not to any one agent — switch models, harnesses, or subscriptions and your links, versions, and feedback come with you. Anything that speaks HTTP can publish.</span></div>
          <div class="fviz" aria-hidden="true"><svg viewBox="0 0 220 96">
      <rect class="db" x="2" y="6" width="68" height="17" rx="8"/><text class="dl" x="36" y="17.5" text-anchor="middle">claude code</text>
      <rect class="db" x="2" y="39" width="68" height="17" rx="8"/><text class="dl" x="36" y="50.5" text-anchor="middle">codex</text>
      <rect class="db" x="2" y="72" width="68" height="17" rx="8"/><text class="dl" x="36" y="83.5" text-anchor="middle">terminal</text>
      <rect class="db" x="150" y="6" width="68" height="17" rx="8"/><text class="dl" x="184" y="17.5" text-anchor="middle">IDE</text>
      <rect class="db" x="150" y="39" width="68" height="17" rx="8"/><text class="dl" x="184" y="50.5" text-anchor="middle">self-hosted</text>
      <rect class="db" x="150" y="72" width="68" height="17" rx="8"/><text class="dl" x="184" y="83.5" text-anchor="middle">any HTTP</text>
      <rect class="da" x="86" y="37" width="48" height="22" rx="6"/><text class="dw9" x="110" y="51" text-anchor="middle">artifact</text>
      <path class="dd" d="M70 14 C 82 14, 80 40, 88 42"/>
      <path class="dd" d="M70 47 H 86"/>
      <path class="dd" d="M70 80 C 82 80, 80 56, 88 54"/>
      <path class="dd" d="M150 14 C 138 14, 140 40, 132 42"/>
      <path class="dd" d="M150 47 H 134"/>
      <path class="dd" d="M150 80 C 138 80, 140 56, 132 54"/>
    </svg></div>
        </div>
      </section>
      <section class="showcase" aria-label="Live example artifacts">
        <div class="show-head">
          <p class="eyebrow">Live on this deployment</p>
          <h2>See what artifacts can be.</h2>
          <p class="muted">Three real artifacts, each built and published by an agent in a single message — and each one documents itself.</p>
        </div>
        <div class="show-grid">
          ${SHOWCASE.map(
            (item) => `<a class="show-card" href="${escapeHtml(item.path)}">
              <span class="vid"><video data-autoplay src="${MEDIA_BASE}${item.video}.mp4" poster="${MEDIA_BASE}${item.video}.jpg" muted loop playsinline preload="none"></video></span>
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(item.desc)}</span>
              <div>${item.tags.map((tag) => `<i>${escapeHtml(tag)}</i>`).join("")}</div>
              <em>Open it →</em>
            </a>`,
          ).join("")}
        </div>
      </section>
      <style>
      /* Chrome drops these two rules from the main sheet (parser quirk with
         the giant inline stylesheet); a separate tag applies them reliably. */
      .loop-head > * { min-width: 0; max-width: 100%; }
      .agents > div { min-width: 0; }
      .agents pre { overflow-x: auto; }
      @media (max-width: 640px) {
        .top nav a:not(.button):not([href="/login"]) { display: none; }
        .loop-ribbon { font-size: 14px; letter-spacing: .1em; }
      }
      </style>
      <script>
      (function () {
        var tp = document.getElementById("loopTP");
        var meas = document.getElementById("loopMeasure");
        if (tp && meas) {
          var mq = matchMedia("(max-width: 640px)");
          var fitPath = function () {
            var svg = tp.closest("svg");
            var path = document.getElementById("loopPath");
            if (mq.matches) {
              svg.setAttribute("viewBox", "0 0 560 252");
              path.setAttribute("d", "M 6 148 C 88 64, 178 44, 258 72 C 348 102, 398 172, 344 206 C 292 238, 232 170, 284 112 C 338 54, 434 46, 554 74");
            } else {
              svg.setAttribute("viewBox", "0 0 1140 230");
              path.setAttribute("d", "M 8 158 C 170 70, 320 44, 465 74 C 585 99, 645 168, 588 196 C 538 220, 480 168, 525 118 C 585 52, 730 30, 866 48 C 985 64, 1055 92, 1134 74");
            }
          };
          fitPath();
          mq.addEventListener("change", fitPath);
          var phrase = "PUBLISH \u25B8 REVIEW \u25B8 AGENT READS \u25B8 APPLIES \u25B8 V2 LIVE \u25B8 SAME LINK \u27F3\u00A0\u00A0";
          meas.textContent = phrase;
          var L = Math.max(1, meas.getComputedTextLength());
          tp.textContent = new Array(25).join(phrase);
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
            tp.setAttribute("startOffset", String(-L * 0.35));
          } else {
            var t0 = performance.now();
            (function step(t) {
              tp.setAttribute("startOffset", String(-(((t - t0) * 0.05) % L)));
              requestAnimationFrame(step);
            })(t0);
          }
        }
      })();
      (function () {
        var vids = document.querySelectorAll("[data-autoplay]");
        if (!vids.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        var io = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              if (e.intersectionRatio >= 0.35) e.target.play().catch(function () {});
              else e.target.pause();
            });
          },
          { threshold: [0, 0.35] },
        );
        vids.forEach(function (v) {
          io.observe(v);
        });
      })();
      document.addEventListener("DOMContentLoaded", function () {
        var dlg = document.querySelector(".vidmodal");
        if (!dlg || typeof dlg.showModal !== "function") return;
        var mv = dlg.querySelector("video");
        var origin = null;
        document.querySelectorAll(".story .vid").forEach(function (box) {
          var v = box.querySelector("video");
          box.setAttribute("role", "button");
          box.setAttribute("tabindex", "0");
          box.setAttribute("aria-label", "Watch this demo larger");
          function open() {
            origin = v;
            var t = v.currentTime;
            if (mv.getAttribute("src") !== v.getAttribute("src")) {
              mv.poster = v.getAttribute("poster");
              mv.src = v.getAttribute("src");
              mv.addEventListener("loadedmetadata", function h() {
                mv.removeEventListener("loadedmetadata", h);
                try { mv.currentTime = t; } catch (e) {}
              });
            } else {
              try { mv.currentTime = t; } catch (e) {}
            }
            v.pause();
            dlg.showModal();
            mv.play().catch(function () {});
          }
          box.addEventListener("click", open);
          box.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          });
        });
        dlg.addEventListener("click", function (e) {
          if (e.target === dlg) dlg.close();
        });
        dlg.querySelector("[data-vm-close]").addEventListener("click", function () {
          dlg.close();
        });
        dlg.addEventListener("close", function () {
          mv.pause();
          if (origin) {
            try { origin.currentTime = mv.currentTime; } catch (e) {}
            origin.play().catch(function () {});
            origin = null;
          }
        });
      });
      </script>
      <section class="agents" id="agents">
        <div>
          <p class="eyebrow">Built for agents first</p>
          <h2>Your agent can set itself up.</h2>
          <p>Point any MCP-capable agent at the endpoint and it authenticates with OAuth — or it requests a token and asks you to approve a one-time code, with no browser on its side.</p>
          <p>No lock-in on either side: swap models, harnesses, or subscriptions any time — your artifacts and their history stay put, and the next agent picks up where the last one left off.</p>
          <p>Everything here is machine-readable. Agents start at <a href="/llms.txt">${escapeHtml(base)}/llms.txt</a>.</p>
        </div>
        <div>
          <div class="codeblock"><button class="copy-btn" type="button" data-copy="mcp-config">Copy</button><pre id="mcp-config">${escapeHtml(mcpConfig(env))}</pre></div>
          <div class="codeblock"><button class="copy-btn" type="button" data-copy="connect-snippet">Copy</button><pre id="connect-snippet"><span class="t-dim"># tokenless agents: device-style connect</span>
POST ${escapeHtml(base)}/api/v1/connect/start
<span class="t-dim"># -> human approves the code at ${escapeHtml(base)}/admin/connect</span>
POST ${escapeHtml(base)}/api/v1/connect/poll
<span class="t-dim"># -> bearer token + ready-to-run setup prompt</span></pre></div>
        </div>
      </section>
      <dialog class="vidmodal" aria-label="Demo video, enlarged">
        <button class="vm-close" data-vm-close aria-label="Close">&times;</button>
        <video muted loop playsinline></video>
      </dialog>
      <footer class="site">
        <span>Artifact Use · MIT licensed</span>
        <nav>
          ${env.ARTIFACT_USE_DOCS_URL ? `<a href="${escapeHtml(env.ARTIFACT_USE_DOCS_URL)}">Docs</a>` : ""}
          <a href="${GITHUB_URL}">GitHub</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          ${reportAbuseAnchor(env)}
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">Agent guide</a>
          <a href="/mcp"><code>MCP endpoint</code></a>
        </nav>
      </footer>
    </main>`,
    {
      robots: "index",
      description:
        "Publish agent-generated HTML tools, dashboards, and folders as stable, gated, reviewable links. MCP, CLI, and HTTP publishing on your own Cloudflare account.",
    },
  );
}

export function renderPrivacyPolicy(..._args: unknown[]): Response {
    return new Response("Privacy policy is not configured for this deployment.", {
      status: 404,
    });
  }
  
  export function renderTermsOfService(..._args: unknown[]): Response {
    return new Response("Terms of service are not configured for this deployment.", {
      status: 404,
    });
  }
  
  function reportAbuseAnchor(env: Env): string {
  const href = abuseMailto(env);
  return href ? `<a href="${escapeHtml(href)}">Report abuse</a>` : "";
}

export async function handlePublisherAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if ((path === "/login" || path === "/signin") && request.method === "GET")
    return startAuth(env, "sign-in");
  if (path === "/signup" && request.method === "GET")
    return startAuth(env, "sign-up");
  if (path === "/invite" && request.method === "GET")
    return startInviteAuth(request, env);
  if (path === "/callback" && request.method === "GET")
    return finishAuth(request, env);
  if (path === "/logout" && request.method === "GET") {
    const session = await getPublisherSession(request, env);
    const headers = new Headers();
    headers.append("Set-Cookie", expireCookie(SESSION_COOKIE));
    headers.append("Set-Cookie", expireCookie(STATE_COOKIE));
    headers.append("Set-Cookie", expireCookie(INVITE_COOKIE));
    headers.append("Set-Cookie", expireAdminCsrfCookie());
    return redirect(
      session?.sessionId ? workosLogoutUrl(session.sessionId) : "/",
      headers,
    );
  }
  return error(405, "method_not_allowed", "method not allowed");
}

export async function handlePublisherAdmin(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const authenticated = await getPublisherSessionAuth(request, env);
  if (!authenticated) {
    // Browsers get the sign-in redirect; agents get instructions instead of
    // a dead-end 302 (same pattern as the artifact gate JSON).
    if (!wantsHtml(request)) return adminGateJson(env);
    const headers = new Headers();
    if (request.method === "GET") {
      const url = new URL(request.url);
      headers.append(
        "Set-Cookie",
        cookie(NEXT_COOKIE, `${url.pathname}${url.search}`, 15 * 60),
      );
    }
    return redirect("/login", headers);
  }
  const { raw, session } = authenticated;
  if (
    request.method === "GET" &&
    (path === "/admin" ||
      path === "/admin/connect" ||
      path === "/admin/team" ||
      path === "/admin/super")
  )
    return spaShell(request, env, raw, session.exp);
  if (request.method !== "GET" && !(await verifyAdminCsrf(request, raw, env)))
    return csrfFailed();
  if (path === "/admin/super/transfer" && request.method === "POST")
    return transferArtifactOwner(request, env, session);
  if (
    (path === "/admin/super/artifact/suspend" ||
      path === "/admin/super/artifact/restore") &&
    request.method === "POST"
  )
    return moderateArtifactAction(request, env, session, path);
  if (
    (path === "/admin/super/org/suspend" ||
      path === "/admin/super/org/restore") &&
    request.method === "POST"
  )
    return moderateOrganizationAction(request, env, session, path);
  if (path === "/admin/artifact/access" && request.method === "POST")
    return updateAccess(request, env, session);
  if (path === "/admin/artifact/share-link" && request.method === "POST")
    return createAdminShareLink(request, env, session);
  if (path === "/admin/artifact/share-link/revoke" && request.method === "POST")
    return revokeAdminShareLink(request, env, session);
  if (path === "/admin/agent-token/revoke" && request.method === "POST")
    return revokeAgentToken(request, env, session);
  if (path === "/admin/team/invite" && request.method === "POST")
    return createPublisherInvite(request, env, session);
  if (path === "/admin/team/invite/revoke" && request.method === "POST")
    return revokePublisherInvite(request, env, session);
  return error(404, "not_found", "publisher admin route not found");
}

// The admin UI is a React SPA served from Workers Static Assets; the worker
// only gates it behind the publisher session and serves the shell for every
// client-side route.
async function spaShell(
  request: Request,
  env: Env,
  rawSession: string,
  sessionExpiresAt: number,
): Promise<Response> {
  const shellUrl = new URL("/admin-app/index.html", request.url);
  const asset = await env.ASSETS.fetch(new Request(shellUrl.toString()));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  for (const [k, v] of Object.entries(SYSTEM_SECURITY_HEADERS))
    headers.set(k, v);
  const csrf = await issueAdminCsrfToken(rawSession, sessionExpiresAt, env);
  headers.append("Set-Cookie", csrf.cookie);
  return new Response(asset.body, { status: asset.status, headers });
}

// Protected JSON reads and token-mint/device-approval writes for the SPA.
// Artifact/team mutations continue to reuse the form-POST endpoints above.
export async function handleAdminUiApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const authenticated = await getPublisherSessionAuth(request, env);
  if (!authenticated)
    return error(401, "session_required", "sign in at /login to continue");
  const { raw, session } = authenticated;
  if (!(await verifyAdminCsrf(request, raw, env))) return csrfFailed();
  if (path === "/admin/api/overview" && request.method === "GET")
    return adminOverviewJson(env, session);
  if (path === "/admin/api/artifact-detail" && request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!id.startsWith("art_"))
      return error(400, "artifact_id_required", "artifact id is required");
    const artifact = await env.DB.prepare(
      "SELECT id, url_key FROM artifacts WHERE id = ? AND org_id = ?",
    )
      .bind(id, session.orgId)
      .first<{ id: string; url_key: string }>();
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const detail = await artifactDetailData(env, session.orgId, id);
    const baseUrl = publicArtifactUrl(env, artifact.url_key);
    return json({
      shares: detail.shares.map((link) => ({
        id: link.id,
        recipient_email: link.recipient_email || null,
        recipient_label: link.recipient_label || null,
        view_count: Number(link.view_count || 0),
        state: link.revoked_at
          ? "revoked"
          : link.expires_at && link.expires_at < nowSec()
            ? "expired"
            : "active",
        url: `${baseUrl}?v=${link.id}`,
      })),
      comments: detail.comments
        .filter((comment) => !comment.parent_comment_id)
        .slice(0, 50)
        .map((comment) => ({
          id: comment.id,
          email: comment.email,
          body: comment.body,
          created_at: comment.created_at,
          resolved_at: comment.resolved_at || null,
        })),
    });
  }
  if (path === "/admin/api/connect" && request.method === "GET") {
    const code = new URL(request.url).searchParams.get("code") || "";
    return adminConnectJson(env, session, code);
  }
  if (path === "/admin/api/connect/approve" && request.method === "POST")
    return adminApproveConnectJson(request, env, session);
  if (path === "/admin/api/team" && request.method === "GET")
    return adminTeamJson(env, session);
  if (path === "/admin/api/agent-prompt" && request.method === "POST")
    return adminMintPromptJson(request, env, session);
  if (path === "/admin/api/super" && request.method === "GET")
    return adminSuperJson(env, session);
  return error(404, "not_found", "admin api route not found");
}

async function adminSuperJson(
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  if (!isSuperAdmin(session, env))
    return error(403, "forbidden", "super admin access is not configured");
  const since30 = nowSec() - 30 * 86400;
  const [artifacts, dailyRows, eventRows, moderationRows] = await Promise.all([
    artifactStatsRows(env, { orderBy: "a.updated_at DESC", limit: 500 }),
    env.DB.prepare(
      `SELECT date(ts, 'unixepoch') AS day, COUNT(*) AS n
       FROM views WHERE ts >= ? GROUP BY day ORDER BY day ASC`,
    )
      .bind(since30)
      .all<{ day: string; n: number }>(),
    env.DB.prepare(
      `SELECT e.*, a.title AS artifact_title, a.url_key AS artifact_url_key
       FROM super_admin_events e
       LEFT JOIN artifacts a ON a.id = e.artifact_id
       ORDER BY e.created_at DESC LIMIT 30`,
    ).all<{
      id: string;
      actor_user_id: string;
      artifact_id: string;
      action: string;
      from_org_id: string | null;
      to_org_id: string | null;
      to_user_id: string | null;
      created_at: number;
      artifact_title: string | null;
      artifact_url_key: string | null;
    }>(),
    env.DB.prepare(
      `SELECT me.*, a.title AS artifact_title, a.url_key AS artifact_url_key
       FROM moderation_events me
       LEFT JOIN artifacts a ON a.id = me.artifact_id
       ORDER BY me.created_at DESC LIMIT 50`,
    ).all<{
      id: string;
      actor_user_id: string;
      scope: "artifact" | "org";
      artifact_id: string | null;
      org_id: string | null;
      action: string;
      reason: string | null;
      created_at: number;
      artifact_title: string | null;
      artifact_url_key: string | null;
    }>(),
  ]);
  return json({
    me: { sub: session.sub, email: session.email },
    site: siteJson(env),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      slug: artifact.slug,
      url_key: artifact.url_key,
      title: artifact.title,
      gate_level: artifact.gate_level,
      status: artifact.status,
      moderation_reason: artifact.moderation_reason,
      moderated_by: artifact.moderated_by,
      moderated_at: artifact.moderated_at,
      org_suspended: Boolean(artifact.org_suspended),
      org_moderation_reason: artifact.org_moderation_reason || null,
      org_id: artifact.org_id,
      created_by: artifact.created_by,
      path: publicArtifactPath(env, artifact.url_key),
      url: publicArtifactUrl(env, artifact.url_key),
      total_views: Number(artifact.total_views || 0),
      share_links: Number(artifact.share_links || 0),
      comment_count: Number(artifact.comment_count || 0),
      file_count: Number(artifact.file_count || 0),
      total_size: Number(artifact.total_size || 0),
      completed_at: artifact.completed_at || null,
      updated_at: Number(artifact.updated_at || 0),
    })),
    daily: dailyRows.results || [],
    events: (eventRows.results || []).map((event) => ({
      id: event.id,
      action: event.action,
      artifact_id: event.artifact_id,
      artifact_title: event.artifact_title,
      actor_user_id: event.actor_user_id,
      from_org_id: event.from_org_id,
      to_org_id: event.to_org_id,
      to_user_id: event.to_user_id,
      created_at: event.created_at,
    })),
    moderationEvents: (moderationRows.results || []).map((event) => ({
      id: event.id,
      actor_user_id: event.actor_user_id,
      scope: event.scope,
      artifact_id: event.artifact_id,
      artifact_title: event.artifact_title,
      artifact_url_key: event.artifact_url_key,
      org_id: event.org_id,
      action: event.action,
      reason: event.reason,
      created_at: event.created_at,
    })),
  });
}

function siteJson(env: Env): Record<string, string> {
  const base = siteBaseUrl(env);
  return {
    base,
    prefix: artifactPathPrefix(env) || "",
    docsUrl: docsUrl(env),
    mcpUrl: `${base}/mcp`,
  };
}

async function adminOverviewJson(
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const since30 = nowSec() - 30 * 86400;
  const [artifacts, maps, views7d, uniqueRow] = await Promise.all([
    artifactStatsRows(env, {
      orgId: session.orgId,
      orderBy: "total_views DESC, a.updated_at DESC",
    }),
    adminMaps(env, session.orgId),
    viewsSince(env, session.orgId, nowSec() - 7 * 86400),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT v.email) AS n
       FROM views v JOIN artifacts a ON a.id = v.artifact_id
       WHERE a.org_id = ?`,
    )
      .bind(session.orgId)
      .first<{ n: number }>(),
  ]);
  const daily: { artifact_id: string; day: string; n: number }[] = [];
  for (const rows of maps.daily.values())
    for (const row of rows)
      if (row.day >= new Date(since30 * 1000).toISOString().slice(0, 10))
        daily.push({
          artifact_id: row.artifact_id,
          day: row.day,
          n: Number(row.n || 0),
        });
  const recent = Array.from(maps.recent.values())
    .flat()
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, 30)
    .map((view) => ({
      artifact_id: view.artifact_id,
      title: view.title || null,
      url_key: view.url_key || null,
      slug: view.slug || null,
      email: view.email,
      ts: Number(view.ts || 0),
    }));
  return json({
    me: {
      sub: session.sub,
      orgId: session.orgId,
      email: session.email,
      name: session.name,
      superAdmin: isSuperAdmin(session, env),
      teamAdmin: isTeamAdmin(session),
    },
    site: siteJson(env),
    totals: {
      views: artifacts.reduce(
        (sum, row) => sum + Number(row.total_views || 0),
        0,
      ),
      viewers: Number(uniqueRow?.n || 0),
      views7d,
      feedback: artifacts.reduce(
        (sum, row) => sum + Number(row.comment_count || 0),
        0,
      ),
    },
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      slug: artifact.slug,
      url_key: artifact.url_key,
      title: artifact.title,
      gate_level: artifact.gate_level,
      status: artifact.status,
      org_suspended: Boolean(artifact.org_suspended),
      path: publicArtifactPath(env, artifact.url_key),
      url: publicArtifactUrl(env, artifact.url_key),
      total_views: Number(artifact.total_views || 0),
      unique_viewers: Number(artifact.unique_viewers || 0),
      last_view_ts: artifact.last_view_ts || null,
      share_links: Number(artifact.share_links || 0),
      comment_count: Number(artifact.comment_count || 0),
      open_comments: Number(artifact.open_comments || 0),
      file_count: Number(artifact.file_count || 0),
      total_size: Number(artifact.total_size || 0),
      completed_at: artifact.completed_at || null,
      updated_at: Number(artifact.updated_at || 0),
      allowlist_lines: allowlistLines(artifact.allowlist_json),
    })),
    daily,
    recent,
  });
}

async function adminConnectJson(
  env: Env,
  session: PublisherSession,
  code: string,
): Promise<Response> {
  const [tokens, quick, pending] = await Promise.all([
    listAgentTokens(env, session.orgId),
    quickConnectPrompt(env, session),
    code ? pendingConnectRequest(env, code) : null,
  ]);
  return json({
    site: siteJson(env),
    quick,
    tokens,
    pending: pending
      ? {
          code: pending.user_code,
          agentLabel: pending.agent_label,
        }
      : null,
  });
}

async function adminApproveConnectJson(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = String(body.code || "");
  if (!normalizeUserCode(code))
    return error(
      400,
      "connect_code_required",
      "a valid connect code is required",
    );
  const pending = await pendingConnectRequest(env, code);
  if (!pending)
    return error(
      404,
      "connect_not_found",
      "connect request not found, expired, or already approved",
    );
  const approved = await approveConnectRequest(env, pending, session);
  if (!approved.ok)
    return error(
      409,
      "connect_already_approved",
      "connect request was already approved",
    );
  return json({ approved: true, label: approved.label });
}

async function adminTeamJson(
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const team = await adminTeam(env, session);
  const canManage = isTeamAdmin(session);
  return json({
    orgId: session.orgId,
    canManage,
    canEdit: canManage && isWorkosOrgId(session.orgId) && !team.error,
    error: team.error,
    members: team.members.map((member) => {
      const user = member.user || {};
      return {
        id: member.id || member.user_id || "",
        email: user.email || member.user_id || "",
        name:
          user.name ||
          [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          "",
        role: roleLabel(member),
        status: member.status || "",
      };
    }),
    invitations: team.invitations
      .filter((invite) => invite.state === "pending" && !invite.revoked_at)
      .map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role_slug || "member",
        state: invite.state || "pending",
        expiresAt: dateLabelFromIso(invite.expires_at),
      })),
  });
}

async function adminMintPromptJson(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
    expires_days?: unknown;
  };
  const label = String(body.label || "")
    .trim()
    .slice(0, 80);
  const days = Number(body.expires_days || 30);
  const minted = await mintCreatorToken(env, {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    label: label || null,
    source: "admin",
    expiresDays: Number.isFinite(days) ? days : 30,
  });
  return json({
    prompt: agentSetupPrompt(env, minted.token, minted.expiresAt),
    expiresAt: minted.expiresAt,
    label: label || "Agent token",
  });
}

function adminGateJson(env: Env): Response {
  const base = siteBaseUrl(env);
  return json(
    {
      error: {
        code: "publisher_session_required",
        message: "the publisher admin is a browser surface",
      },
      access: {
        human: `sign in at ${base}/admin in a browser`,
        agent_connect: `no token? POST ${base}/api/v1/connect/start, have your human approve the code at ${base}/admin/connect, then POST ${base}/api/v1/connect/poll for a bearer token`,
        api: `with a bearer token, use ${base}/api/v1/me, ${base}/api/v1/artifacts, and ${base}/mcp instead of /admin`,
        guide: `${base}/llms.txt`,
      },
    },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="artifact-use"' },
    },
  );
}

async function startAuth(
  env: Env,
  screenHint: "sign-in" | "sign-up",
  invitationToken?: string | null,
): Promise<Response> {
  if (!env.WORKOS_CLIENT_ID)
    return error(500, "workos_not_configured", "WORKOS_CLIENT_ID is missing");
  const state = randomId("st");
  const url = new URL("https://api.workos.com/user_management/authorize");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.SITE_BASE_URL}/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("screen_hint", screenHint);
  url.searchParams.set("state", state);
  if (invitationToken)
    url.searchParams.set("invitation_token", invitationToken);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie(STATE_COOKIE, state, 10 * 60));
  if (invitationToken)
    headers.append(
      "Set-Cookie",
      cookie(INVITE_COOKIE, invitationToken, 30 * 60),
    );
  return redirect(url.toString(), headers);
}

async function startInviteAuth(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("invitation_token") || "";
  if (!token)
    return error(400, "invitation_token_required", "invitation token required");
  return startAuth(env, "sign-up", token);
}

async function finishAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return page(
      "Sign in failed",
      `<main class="panel narrow"><h1>Sign in failed</h1><p class="muted">${escapeHtml(errorParam)}</p><a class="button" href="/login">Try again</a></main>`,
    );
  }
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code)
    return authFailure(error(400, "code_required", "code is required"));
  if (!state || state !== readCookie(request, STATE_COOKIE))
    return authFailure(
      error(
        400,
        "invalid_state",
        "This sign-in link was already used or has expired. Signing in again gets you a fresh one.",
      ),
    );
  if (!env.WORKOS_CLIENT_ID || !env.WORKOS_API_KEY)
    return error(500, "workos_not_configured", "WorkOS auth is not configured");

  const invitationToken = readCookie(request, INVITE_COOKIE);
  // Codes are single-use and short-lived: refreshes and double-clicks land
  // here with a dead code. Show a retry page, not a raw error.
  let auth: Record<string, unknown>;
  try {
    auth = await exchangeCode(request, env, code, invitationToken);
  } catch (e) {
    const message =
      e instanceof WorkosApiError
        ? "The sign-in code or invitation was already used or has expired."
        : e instanceof Error
          ? e.message
          : "Sign in could not be completed.";
    return authFailure(
      page(
        "Sign in failed",
        `<main class="panel narrow">
        <p class="eyebrow">Sign in</p>
        <h1>That didn't go through.</h1>
        <p class="muted">${escapeHtml(message)} This usually happens when a sign-in link is opened twice — starting over fixes it.</p>
        <div class="actions"><a class="button" href="/login">Sign in again</a><a class="button ghost" href="/">Go to homepage</a></div>
      </main>`,
      ),
    );
  }
  const user = (auth.user || {}) as Record<string, unknown>;
  const userId = stringClaim(user.id) || stringClaim(auth.user_id);
  const email = stringClaim(user.email) || stringClaim(auth.email);
  const accessClaims = decodeJwtClaims(stringClaim(auth.access_token)) || {};
  const fallbackOrgIds = [
    userId ? legacyPublisherUserOrgId(userId) : "",
    userId ? userScopedOrgId(userId) : "",
    email ? `email:${email}` : "",
  ].filter(Boolean);
  const authOrgId =
    stringClaim(auth.organization_id) ||
    stringClaim(auth.organizationId) ||
    stringClaim(accessClaims.org_id) ||
    stringClaim(accessClaims.organization_id);
  let orgId = authOrgId || fallbackOrgIds[0] || "";
  if (!orgId || !userId)
    return error(
      401,
      "invalid_workos_response",
      "WorkOS response is missing user identity",
    );
  const name = [stringClaim(user.first_name), stringClaim(user.last_name)]
    .filter(Boolean)
    .join(" ");
  const roles = sessionRoles(auth);
  const permissions = sessionPermissions(auth);
  if (!authOrgId) {
    const workosOrg = await ensurePublisherOrganization(
      env,
      userId,
      email,
      name,
    );
    if (workosOrg) {
      orgId = workosOrg;
      await migratePublisherDataToOrg(env, fallbackOrgIds, workosOrg, userId);
      if (!roles.length) roles.push("admin");
    }
  } else if (await isOwnedPublisherOrganization(env, authOrgId, userId)) {
    await migratePublisherDataToOrg(env, fallbackOrgIds, authOrgId, userId);
  }
  const session: PublisherSession = {
    typ: "publisher",
    sub: userId,
    orgId,
    email,
    name: name || stringClaim(user.email) || null,
    role: roles[0] || null,
    roles,
    permissions,
    sessionId:
      stringClaim(auth.session_id) ||
      stringClaim(auth.sessionId) ||
      stringClaim(accessClaims.sid),
    organizationMembershipId: stringClaim(auth.organization_membership_id),
    exp: nowSec() + 7 * 86400,
  };
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    cookie(SESSION_COOKIE, await signPayload(session, env), 7 * 86400),
  );
  headers.append("Set-Cookie", expireCookie(STATE_COOKIE));
  headers.append("Set-Cookie", expireCookie(INVITE_COOKIE));
  // Honor a pre-auth destination (e.g. /admin/connect?code=...) set before the
  // sign-in redirect. Same-site relative paths only.
  const next = readCookie(request, NEXT_COOKIE);
  const dest = next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : "/admin";
  if (next) headers.append("Set-Cookie", expireCookie(NEXT_COOKIE));
  return redirect(dest, headers);
}

async function exchangeCode(
  request: Request,
  env: Env,
  code: string,
  invitationToken?: string | null,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    grant_type: "authorization_code",
    client_id: env.WORKOS_CLIENT_ID,
    client_secret: env.WORKOS_API_KEY,
    code,
    ip_address: request.headers.get("CF-Connecting-IP") || undefined,
    user_agent: request.headers.get("User-Agent") || undefined,
  };
  if (invitationToken) body.invitation_token = invitationToken;
  try {
    return await workosApi(env, {
      path: "/user_management/authenticate",
      method: "POST",
      body,
    });
  } catch (e) {
    // The message surfaces in the 500 response body on failed sign-in.
    if (e instanceof WorkosApiError)
      throw new Error(`WorkOS auth failed: ${e.message}`);
    throw e;
  }
}

async function ensurePublisherOrganization(
  env: Env,
  userId: string,
  email: string | null,
  name: string,
): Promise<string | null> {
  if (!env.WORKOS_API_KEY) return null;
  const externalId = `artifact-use:${userId}`;
  const existing = await workosApiMaybe(
    env,
    `/organizations/external_id/${encodeURIComponent(externalId)}`,
  );
  const organization =
    existing ||
    (await workosApi(env, {
      path: "/organizations",
      method: "POST",
      body: {
        name: name || email || "Artifact Use publisher",
        external_id: externalId,
        metadata: {
          artifact_use_owner_user_id: userId,
          artifact_use_owner_email: email || "",
        },
      },
    }));
  const orgId = stringClaim(organization.id);
  if (!orgId) return null;
  await ensureWorkosMembership(env, orgId, userId, "admin");
  return orgId;
}

async function ensureWorkosMembership(
  env: Env,
  orgId: string,
  userId: string,
  roleSlug: string,
): Promise<void> {
  const params = new URLSearchParams({
    organization_id: orgId,
    user_id: userId,
    limit: "10",
  });
  const memberships = await workosApi(env, {
    path: `/user_management/organization_memberships?${params}`,
  });
  const existing = asArray(memberships.data).find(
    (row) =>
      stringClaim((row as Record<string, unknown>).organization_id) === orgId &&
      stringClaim((row as Record<string, unknown>).user_id) === userId,
  );
  if (existing) return;
  await workosApi(env, {
    path: "/user_management/organization_memberships",
    method: "POST",
    body: {
      organization_id: orgId,
      user_id: userId,
      role_slug: roleSlug,
    },
  });
}

async function isOwnedPublisherOrganization(
  env: Env,
  orgId: string,
  userId: string,
): Promise<boolean> {
  if (!isWorkosOrgId(orgId) || !env.WORKOS_API_KEY) return false;
  const organization = await workosApiMaybe(
    env,
    `/organizations/${encodeURIComponent(orgId)}`,
  );
  if (!organization) return false;
  const metadata =
    organization.metadata && typeof organization.metadata === "object"
      ? (organization.metadata as Record<string, unknown>)
      : {};
  return (
    stringClaim(organization.external_id) === `artifact-use:${userId}` ||
    stringClaim(metadata.artifact_use_owner_user_id) === userId
  );
}

async function migratePublisherDataToOrg(
  env: Env,
  fromOrgIds: string[],
  toOrgId: string,
  userId: string,
): Promise<void> {
  const unique = [...new Set(fromOrgIds.filter((id) => id && id !== toOrgId))];
  const now = nowSec();
  for (const fromOrgId of unique) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE artifact_versions SET org_id = ?, created_by = ? WHERE org_id = ?",
      ).bind(toOrgId, userId, fromOrgId),
      env.DB.prepare(
        `UPDATE share_links
         SET created_by = ?
         WHERE artifact_id IN (SELECT id FROM artifacts WHERE org_id = ?)`,
      ).bind(userId, fromOrgId),
      env.DB.prepare(
        "UPDATE artifacts SET org_id = ?, created_by = ?, updated_at = ? WHERE org_id = ?",
      ).bind(toOrgId, userId, now, fromOrgId),
    ]);
  }
}

type AgentTokenRow = {
  id: string;
  label: string | null;
  source: string;
  created_at: number;
  expires_at: number;
};

async function listAgentTokens(
  env: Env,
  orgId: string,
): Promise<AgentTokenRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, label, source, created_at, expires_at FROM creator_tokens
     WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 25`,
  )
    .bind(orgId, nowSec())
    .all<AgentTokenRow>();
  return rows.results || [];
}

type QuickPrompt = { prompt: string; expiresAt: number };

// The connect page always has a ready-to-paste prompt. The minted token's raw
// value is parked on its registry row so reloads re-display the same prompt
// instead of minting a token per view; revoking the "Quick connect" token
// rotates it on the next load.
async function quickConnectPrompt(
  env: Env,
  session: PublisherSession,
): Promise<QuickPrompt | null> {
  // Reuse the parked prompt while its token has comfortable life left.
  const parked = await env.DB.prepare(
    `SELECT parked_token, expires_at FROM creator_tokens
     WHERE org_id = ? AND source = 'quick' AND revoked_at IS NULL
       AND parked_token IS NOT NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(session.orgId, nowSec() + 86400)
    .first<{ parked_token: string; expires_at: number }>();
  if (parked)
    return {
      prompt: agentSetupPrompt(env, parked.parked_token, parked.expires_at),
      expiresAt: parked.expires_at,
    };
  const minted = await mintCreatorToken(env, {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    label: "Quick connect",
    source: "quick",
    expiresDays: 30,
  });
  await env.DB.prepare(
    "UPDATE creator_tokens SET parked_token = ? WHERE id = ?",
  )
    .bind(minted.token, minted.id)
    .run();
  return {
    prompt: agentSetupPrompt(env, minted.token, minted.expiresAt),
    expiresAt: minted.expiresAt,
  };
}

async function adminTeam(
  env: Env,
  session: PublisherSession,
): Promise<WorkosTeam> {
  if (!env.WORKOS_API_KEY) {
    return {
      members: [],
      invitations: [],
      error: "WorkOS API key is not configured for team management.",
    };
  }
  if (!isWorkosOrgId(session.orgId)) {
    return {
      members: [],
      invitations: [],
      error:
        "Team invites need a refreshed session for this workspace. Sign out, sign back in, and try again.",
    };
  }
  try {
    const [memberships, invitations] = await Promise.all([
      workosApi(env, {
        path: `/user_management/organization_memberships?${new URLSearchParams({
          organization_id: session.orgId,
          limit: "100",
        })}`,
      }),
      workosApi(env, {
        path: `/user_management/invitations?${new URLSearchParams({
          organization_id: session.orgId,
          limit: "100",
          order: "desc",
        })}`,
      }),
    ]);
    return {
      members: asArray(memberships.data) as WorkosMembership[],
      invitations: asArray(invitations.data) as WorkosInvitation[],
      error: null,
    };
  } catch (e) {
    return {
      members: [],
      invitations: [],
      error:
        e instanceof Error
          ? e.message
          : "WorkOS team data could not be loaded.",
    };
  }
}

function roleLabel(member: WorkosMembership): string {
  const roles = [
    ...(member.roles || []).map((role) => role.slug).filter(Boolean),
    member.role?.slug,
  ].filter(Boolean);
  return roles.join(", ") || "member";
}

async function adminMaps(env: Env, orgId: string): Promise<AdminMaps> {
  const since30 = nowSec() - 30 * 86400;
  const [recentRows, dailyRows] = await Promise.all([
    env.DB.prepare(
      `SELECT v.artifact_id, a.slug, a.url_key, a.title, v.email, v.verified, v.ts, v.referrer
       FROM views v
       JOIN artifacts a ON a.id = v.artifact_id
       WHERE a.org_id = ?
       ORDER BY v.ts DESC
       LIMIT 200`,
    )
      .bind(orgId)
      .all<AdminRecentView>(),
    env.DB.prepare(
      `SELECT v.artifact_id, date(v.ts, 'unixepoch') AS day, COUNT(*) AS n
       FROM views v
       JOIN artifacts a ON a.id = v.artifact_id
       WHERE a.org_id = ? AND v.ts >= ?
       GROUP BY v.artifact_id, day
       ORDER BY day ASC`,
    )
      .bind(orgId, since30)
      .all<AdminDailyView>(),
  ]);

  return {
    recent: groupBy(recentRows.results || [], "artifact_id"),
    daily: groupBy(dailyRows.results || [], "artifact_id"),
  };
}

// Sheet-only data, scoped to the single open artifact.
async function artifactDetailData(
  env: Env,
  orgId: string,
  artifactId: string,
): Promise<{ shares: AdminShareLink[]; comments: AdminComment[] }> {
  const [shareRows, commentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT sl.*, a.id AS artifact_id, COUNT(v.id) AS view_count
       FROM share_links sl
       JOIN artifacts a ON a.id = sl.artifact_id
       LEFT JOIN views v ON v.share_link_id = sl.id
       WHERE a.org_id = ? AND a.id = ?
       GROUP BY sl.id
       ORDER BY sl.created_at DESC`,
    )
      .bind(orgId, artifactId)
      .all<AdminShareLink>(),
    env.DB.prepare(
      `SELECT c.*
       FROM comments c
       WHERE c.artifact_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT 100`,
    )
      .bind(artifactId)
      .all<AdminComment>(),
  ]);
  return {
    shares: shareRows.results || [],
    comments: commentRows.results || [],
  };
}

// Shared stats aggregation behind the admin and super-admin tables. orgId is
// bound as a parameter; orderBy/limit are interpolated and must remain
// internal literals, never caller/user input.
async function artifactStatsRows(
  env: Env,
  opts: { orgId?: string; orderBy: string; limit?: number },
): Promise<ArtifactRow[]> {
  const stmt = env.DB.prepare(
    `SELECT a.*,
      CASE WHEN MAX(os.org_id) IS NULL THEN 0 ELSE 1 END AS org_suspended,
      MAX(os.reason) AS org_moderation_reason,
      av.file_count AS file_count,
      av.total_size AS total_size,
      av.completed_at AS completed_at,
      COUNT(DISTINCT v.id) AS total_views,
      COUNT(DISTINCT v.email) AS unique_viewers,
      MAX(v.ts) AS last_view_ts,
      COUNT(DISTINCT sl.id) AS share_links,
      COUNT(DISTINCT c.id) AS comment_count,
      COUNT(DISTINCT CASE
        WHEN c.parent_comment_id IS NULL AND c.resolved_at IS NULL THEN c.id
        ELSE NULL
      END) AS open_comments
     FROM artifacts a
     LEFT JOIN org_suspensions os ON os.org_id = a.org_id
     LEFT JOIN artifact_versions av ON av.id = a.current_version_id
     LEFT JOIN views v ON v.artifact_id = a.id
     LEFT JOIN share_links sl ON sl.artifact_id = a.id
     LEFT JOIN comments c ON c.artifact_id = a.id AND c.deleted_at IS NULL
     ${opts.orgId ? "WHERE a.org_id = ?" : ""}
     GROUP BY a.id
     ORDER BY ${opts.orderBy}${opts.limit ? ` LIMIT ${opts.limit}` : ""}`,
  );
  const bound = opts.orgId ? stmt.bind(opts.orgId) : stmt;
  return (await bound.all<ArtifactRow>()).results || [];
}

async function viewsSince(
  env: Env,
  orgId: string,
  since: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM views v
     JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.org_id = ? AND v.ts >= ?`,
  )
    .bind(orgId, since)
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

async function transferArtifactOwner(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  if (!isSuperAdmin(session, env))
    return error(403, "forbidden", "super admin access is not configured");
  const form = await request.formData();
  const artifactId = String(form.get("artifact_id") || "").trim();
  const targetOrgId = String(form.get("target_org_id") || "").trim();
  const targetUserId = String(form.get("target_user_id") || "").trim();
  if (!artifactId.startsWith("art_"))
    return error(400, "invalid_artifact", "artifact id is required");
  if (!isWorkosOrgId(targetOrgId))
    return error(400, "invalid_org", "target org must be a WorkOS org id");
  if (!targetUserId.startsWith("user_"))
    return error(400, "invalid_user", "target user must be a WorkOS user id");
  if (!(await workosUserInOrg(env, targetOrgId, targetUserId)))
    return error(
      400,
      "user_not_in_org",
      "target user is not an active member of the target organization",
    );
  const artifact = await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(artifactId)
    .first<Artifact>();
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  const slug = await transferSlug(env, artifact, targetOrgId);
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE artifact_versions SET org_id = ?, created_by = ? WHERE artifact_id = ?",
    ).bind(targetOrgId, targetUserId, artifact.id),
    env.DB.prepare(
      "UPDATE share_links SET created_by = ? WHERE artifact_id = ?",
    ).bind(targetUserId, artifact.id),
    env.DB.prepare(
      "UPDATE artifacts SET org_id = ?, slug = ?, created_by = ?, updated_at = ? WHERE id = ?",
    ).bind(targetOrgId, slug, targetUserId, now, artifact.id),
    env.DB.prepare(
      `INSERT INTO super_admin_events
       (id, actor_user_id, artifact_id, action, from_org_id, to_org_id, to_user_id, created_at)
       VALUES (?, ?, ?, 'transfer_artifact', ?, ?, ?, ?)`,
    ).bind(
      randomId("evt"),
      session.sub,
      artifact.id,
      artifact.org_id,
      targetOrgId,
      targetUserId,
      now,
    ),
  ]);
  return redirect(`/admin/super?open=${encodeURIComponent(artifact.id)}`);
}

async function transferSlug(
  env: Env,
  artifact: Artifact,
  targetOrgId: string,
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM artifacts WHERE org_id = ? AND slug = ? AND id <> ? LIMIT 1",
  )
    .bind(targetOrgId, artifact.slug, artifact.id)
    .first<{ id: string }>();
  if (!existing) return artifact.slug;
  const code = artifactUrlCode(artifact.id);
  for (let i = 0; i < 20; i += 1) {
    const slug = transferCandidateSlug(artifact.slug, code, i);
    const collision = await env.DB.prepare(
      "SELECT id FROM artifacts WHERE org_id = ? AND slug = ? AND id <> ? LIMIT 1",
    )
      .bind(targetOrgId, slug, artifact.id)
      .first<{ id: string }>();
    if (!collision) return slug;
  }
  throw new Error("could not find a unique slug for target org");
}

function transferCandidateSlug(
  slug: string,
  code: string,
  attempt: number,
): string {
  const suffix = attempt ? `-${code}-${attempt}` : `-${code}`;
  const base = slugify(slug || "artifact", "artifact")
    .slice(0, Math.max(1, 63 - suffix.length))
    .replace(/-+$/g, "");
  return `${base || "artifact"}${suffix}`;
}

async function workosUserInOrg(
  env: Env,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    organization_id: orgId,
    user_id: userId,
    limit: "10",
  });
  const memberships = await workosApi(env, {
    path: `/user_management/organization_memberships?${params}`,
  });
  return asArray(memberships.data).some((row) => {
    const membership = row as Record<string, unknown>;
    return (
      stringClaim(membership.organization_id) === orgId &&
      stringClaim(membership.user_id) === userId &&
      stringClaim(membership.status) === "active"
    );
  });
}

async function moderateArtifactAction(
  request: Request,
  env: Env,
  session: PublisherSession,
  path: string,
): Promise<Response> {
  if (!isSuperAdmin(session, env))
    return error(403, "forbidden", "super admin access is not configured");
  const form = await request.formData();
  const artifactId = String(form.get("artifact_id") || "").trim();
  if (!artifactId.startsWith("art_") || artifactId.length > 200)
    return error(400, "artifact_id_required", "artifact id is required");
  const action = path.endsWith("/suspend") ? "suspend" : "restore";
  const reason = moderationReason(form, action === "suspend");
  if (reason instanceof Response) return reason;
  const found = await moderateArtifact(env, {
    actorUserId: session.sub,
    artifactId,
    action,
    reason,
  });
  if (!found) return error(404, "artifact_not_found", "artifact not found");
  return redirect(`/admin/super?open=${encodeURIComponent(artifactId)}`);
}

async function moderateOrganizationAction(
  request: Request,
  env: Env,
  session: PublisherSession,
  path: string,
): Promise<Response> {
  if (!isSuperAdmin(session, env))
    return error(403, "forbidden", "super admin access is not configured");
  const form = await request.formData();
  const orgId = String(form.get("org_id") || "").trim();
  if (!orgId || orgId.length > 200)
    return error(400, "org_id_required", "organization id is required");
  const action = path.endsWith("/suspend") ? "suspend" : "restore";
  const reason = moderationReason(form, action === "suspend");
  if (reason instanceof Response) return reason;
  await moderateOrganization(env, {
    actorUserId: session.sub,
    orgId,
    action,
    reason,
  });
  return redirect("/admin/super");
}

function moderationReason(
  form: FormData,
  required: boolean,
): string | null | Response {
  if (!required) return null;
  const reason = String(form.get("reason") || "").trim();
  if (!reason)
    return error(
      400,
      "moderation_reason_required",
      "a moderation reason is required",
    );
  if (reason.length > 500)
    return error(
      400,
      "moderation_reason_too_long",
      "moderation reason must be 500 characters or fewer",
    );
  return reason;
}

function isSuperAdmin(session: PublisherSession, env: Env): boolean {
  const ids = new Set(
    String(env.ARTIFACT_USE_SUPER_ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return Boolean(session.sub && ids.has(session.sub));
}

function groupBy<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const value = String(row[key] || "");
    if (!value) continue;
    const group = map.get(value) || [];
    group.push(row);
    map.set(value, group);
  }
  return map;
}

function mcpConfig(env: Env): string {
  return JSON.stringify(
    {
      mcpServers: {
        "artifact-use": {
          type: "http",
          url: `${env.SITE_BASE_URL}/mcp`,
        },
      },
    },
    null,
    2,
  );
}

function allowlistLines(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as {
      domains?: string[];
      emails?: string[];
    };
    return [...(parsed.domains || []), ...(parsed.emails || [])].join("\n");
  } catch {
    return "";
  }
}

function parseAllowlist(value: FormDataEntryValue | null): string | undefined {
  if (value === null) return undefined;
  const lines = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const domains: string[] = [];
  const emails: string[] = [];
  for (const line of lines) {
    if (line.includes("@")) emails.push(normalizeEmail(line));
    else domains.push(line.replace(/^@/, "").toLowerCase());
  }
  return JSON.stringify({ domains, emails });
}

function dateLabelFromIso(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 10);
}

async function updateAccess(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const gateLevel = String(form.get("gate_level") || "") as GateLevel;
  if (!GATE_LEVELS.has(gateLevel))
    return error(400, "invalid_gate_level", "gate_level is not supported");
  const artifact = await publisherArtifact(env, session, form);
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  await updateArtifactAccess(
    env,
    artifact,
    null,
    gateLevel,
    parseAllowlist(form.get("allowlist_lines")),
  );
  return redirect(`/admin?open=${encodeURIComponent(artifact.id)}`);
}

async function createAdminShareLink(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const artifact = await publisherArtifact(env, session, form);
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  const rawEmail = String(form.get("recipient_email") || "").trim();
  const days = Number(form.get("expires_days") || 0);
  const expiresAt =
    Number.isFinite(days) && days > 0
      ? nowSec() + Math.max(1, Math.min(365, Math.floor(days))) * 86400
      : null;
  await createShareLink(
    env,
    artifact,
    creatorFromSession(session),
    rawEmail ? normalizeEmail(rawEmail) : null,
    String(form.get("recipient_label") || "").trim() || null,
    expiresAt,
  );
  return redirect(`/admin?open=${encodeURIComponent(artifact.id)}`);
}

async function revokeAdminShareLink(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("id") || "");
  const row = await env.DB.prepare(
    `SELECT sl.id, a.id AS artifact_id
     FROM share_links sl
     JOIN artifacts a ON a.id = sl.artifact_id
     WHERE sl.id = ? AND a.org_id = ?`,
  )
    .bind(id, session.orgId)
    .first<{ id: string; artifact_id: string }>();
  if (!row) return error(404, "share_link_not_found", "share link not found");
  await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ?")
    .bind(nowSec(), id)
    .run();
  return redirect(`/admin?open=${encodeURIComponent(row.artifact_id)}`);
}

async function revokeAgentToken(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get("id") || "").trim();
  if (!id.startsWith("crt_"))
    return error(400, "token_id_required", "token id is required");
  await env.DB.prepare(
    "UPDATE creator_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL",
  )
    .bind(nowSec(), id, session.orgId)
    .run();
  return redirect("/admin/connect");
}

// Temporary compatibility redirect. Approval only exists inside the protected
// admin namespace; this legacy path must never mutate state again.
export async function handleConnectPage(
  request: Request,
  _env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET")
    return error(405, "method_not_allowed", "method not allowed");
  return redirect(`/admin/connect${url.search}`);
}

async function createPublisherInvite(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  if (!isTeamAdmin(session))
    return error(403, "forbidden", "team management requires an admin role");
  if (!isWorkosOrgId(session.orgId))
    return error(
      400,
      "workos_org_required",
      "publisher account must be backed by a WorkOS organization",
    );
  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") || ""));
  if (!email) return error(400, "email_required", "email is required");
  const roleSlug = teamRole(String(form.get("role_slug") || "member"));
  if (!roleSlug)
    return error(400, "invalid_role", "role must be member or admin");
  const days = Number(form.get("expires_days") || 14);
  const expiresInDays =
    Number.isFinite(days) && days > 0
      ? Math.max(1, Math.min(30, Math.floor(days)))
      : 14;
  try {
    await workosApi(env, {
      path: "/user_management/invitations",
      method: "POST",
      body: {
        email,
        organization_id: session.orgId,
        role_slug: roleSlug,
        expires_in_days: expiresInDays,
        inviter_user_id: session.sub,
      },
    });
  } catch (e) {
    if (e instanceof WorkosApiError)
      return error(502, "workos_invite_failed", e.message);
    throw e;
  }
  return redirect("/admin/team");
}

async function revokePublisherInvite(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  if (!isTeamAdmin(session))
    return error(403, "forbidden", "team management requires an admin role");
  const form = await request.formData();
  const id = String(form.get("id") || "").trim();
  if (!id) return error(400, "invitation_required", "invitation id required");
  const invite = (await workosApiMaybe(
    env,
    `/user_management/invitations/${encodeURIComponent(id)}`,
  )) as WorkosInvitation | null;
  if (!invite)
    return error(404, "invitation_not_found", "invitation not found");
  if (invite.organization_id !== session.orgId)
    return error(404, "invitation_not_found", "invitation not found");
  try {
    await workosApi(env, {
      path: `/user_management/invitations/${encodeURIComponent(id)}/revoke`,
      method: "POST",
    });
  } catch (e) {
    if (e instanceof WorkosApiError)
      return error(502, "workos_revoke_failed", e.message);
    throw e;
  }
  return redirect("/admin/team");
}

function isTeamAdmin(session: PublisherSession): boolean {
  const roles = sessionRoleList(session);
  const permissions = session.permissions || [];
  if (!roles.length && !permissions.length) return true;
  return (
    roles.some((role) => TEAM_ADMIN_ROLES.has(role)) ||
    permissions.some((permission) => TEAM_MANAGE_PERMISSIONS.has(permission))
  );
}

function sessionRoleList(session: PublisherSession): string[] {
  return [...(session.roles || []), session.role || ""]
    .map((role) => role.toLowerCase().trim())
    .filter(Boolean);
}

function teamRole(value: string): string | null {
  const role = value.toLowerCase().trim() || "member";
  if (!TEAM_ROLE_OPTIONS.includes(role)) return null;
  return role;
}

function isWorkosOrgId(value: string): boolean {
  return value.startsWith("org_");
}

function sessionRoles(auth: Record<string, unknown>): string[] {
  const claims = decodeJwtClaims(stringClaim(auth.access_token)) || {};
  return [
    ...extractStringArray(auth.roles),
    ...extractStringArray(auth.role),
    ...extractStringArray(claims.roles),
    ...extractStringArray(claims.role),
  ]
    .map((role) => role.toLowerCase())
    .filter((role, index, all) => role && all.indexOf(role) === index);
}

function sessionPermissions(auth: Record<string, unknown>): string[] {
  const claims = decodeJwtClaims(stringClaim(auth.access_token)) || {};
  return [
    ...extractStringArray(auth.permissions),
    ...extractStringArray(claims.permissions),
    ...extractStringArray(claims.scope),
    ...extractStringArray(claims.scp),
  ].filter(
    (permission, index, all) => permission && all.indexOf(permission) === index,
  );
}

function decodeJwtClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    return JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function legacyPublisherUserOrgId(userId: string): string {
  return `user:${userId}`;
}

async function publisherArtifact(
  env: Env,
  session: PublisherSession,
  form: FormData,
): Promise<Artifact | null> {
  const artifactKey = String(form.get("artifact_key") || "").trim();
  if (artifactKey) {
    return env.DB.prepare(
      "SELECT * FROM artifacts WHERE url_key = ? AND org_id = ?",
    )
      .bind(artifactKey, session.orgId)
      .first<Artifact>();
  }
  return null;
}

function creatorFromSession(session: PublisherSession): Creator {
  return {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    permissions: new Set(
      session.permissions?.length ? session.permissions : ["artifacts:admin"],
    ),
    raw: { publisher_session: true },
  };
}

async function getPublisherSession(
  request: Request,
  env: Env,
): Promise<PublisherSession | null> {
  return (await getPublisherSessionAuth(request, env))?.session || null;
}

async function getPublisherSessionAuth(
  request: Request,
  env: Env,
): Promise<{ raw: string; session: PublisherSession } | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const session = await verifyPayload<PublisherSession>(raw, env);
  // The typ check keeps viewer/upload tokens (same secret, same format) from
  // ever verifying as a publisher session.
  if (!session || session.typ !== "publisher" || session.exp < nowSec())
    return null;
  return { raw, session };
}

function csrfFailed(): Response {
  return error(403, "csrf_failed", "admin CSRF validation failed");
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

// A failed sign-in must clear the auth cookies: a stale invitation token or
// state cookie otherwise poisons every retry (dead invitation attached to the
// next exchange → fails again → loop).
function authFailure(response: Response): Response {
  response.headers.append("Set-Cookie", expireCookie(STATE_COOKIE));
  response.headers.append("Set-Cookie", expireCookie(INVITE_COOKIE));
  return response;
}

function expireCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  const out = new Headers(headers);
  out.set("Location", location);
  return new Response(null, {
    status: 302,
    headers: out,
  });
}

function workosLogoutUrl(sessionId: string): string {
  const url = new URL("https://api.workos.com/user_management/sessions/logout");
  url.searchParams.set("session_id", sessionId);
  return url.toString();
}

// Inline SVG mark: teal plate, chartreuse signal dot, two "document" rules.
const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230b5d52'/%3E%3Ccircle%20cx='22'%20cy='10.5'%20r='5'%20fill='%23d8ff4a'/%3E%3Crect%20x='7'%20y='17'%20width='12'%20height='2.6'%20rx='1.3'%20fill='%23fffdf7'/%3E%3Crect%20x='7'%20y='22'%20width='17'%20height='2.6'%20rx='1.3'%20fill='%23fffdf7'/%3E%3C/svg%3E";

// One shared clipboard handler: any element with data-copy="<id>" copies the
// value/text of that element and flips its own label briefly.
const COPY_SCRIPT = `<script>addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=document.getElementById(b.getAttribute("data-copy"));if(!t)return;var v="value"in t&&t.value?t.value:t.textContent||"";navigator.clipboard.writeText(v).then(function(){var o=b.textContent;b.textContent="Copied";b.classList.add("copied");setTimeout(function(){b.textContent=o;b.classList.remove("copied")},1400)})});
(function(){
  function bar(){if(document.querySelector(".loadbar"))return;var b=document.createElement("div");b.className="loadbar";document.body.appendChild(b);}
  addEventListener("click",function(e){
    if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.button!==0)return;
    var a=e.target.closest("a[href]");
    if(!a||a.target==="_blank"||a.closest("[data-copy]"))return;
    var href=a.getAttribute("href")||"";
    if(href.charAt(0)==="#")return;
    try{if(new URL(a.href,location.href).origin!==location.origin)return}catch(_){return}
    bar();
  });
  addEventListener("submit",function(){bar()});
  addEventListener("pageshow",function(e){if(e.persisted)document.querySelectorAll(".loadbar,.skel-holder").forEach(function(n){n.remove()})});
})();</script>`;

// Branded full-page error for browsers. Agents keep the JSON envelopes; the
// adapter in index.ts decides which one a response becomes.
export function errorPage(env: Env, status: number, detail: string): Response {
  const known: Record<number, { title: string; hint: string }> = {
    401: {
      title: "Sign in to continue",
      hint: "This page needs a signed-in publisher session.",
    },
    403: {
      title: "You don't have access",
      hint: "This account isn't allowed to view this page.",
    },
    404: {
      title: "Page not found",
      hint: "The link may be mistyped, expired, or the artifact may have moved.",
    },
    405: { title: "That didn't work", hint: "" },
  };
  const kind =
    known[status] ||
    (status >= 500
      ? {
          title: "Something went wrong",
          hint: "An unexpected error occurred on our side. Trying again usually helps.",
        }
      : { title: "That didn't work", hint: "" });
  // Never surface internal 5xx details to browsers.
  const message =
    status >= 500 ? kind.hint : [detail, kind.hint].filter(Boolean).join(" — ");
  return page(
    kind.title,
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav><a href="/login">Sign in</a></nav>
    </header>
    <main class="panel narrow">
      <p class="eyebrow">${status}</p>
      <h1>${escapeHtml(kind.title)}.</h1>
      <p class="muted">${escapeHtml(message || "Something about this request didn't add up.")}</p>
      <div class="actions">
        <a class="button" href="/">Go to homepage</a>
        ${status === 401 || status === 403 ? `<a class="button ghost" href="/login">Sign in</a>` : `<a class="button ghost" href="${escapeHtml(docsUrl(env))}">Read the docs</a>`}
      </div>
    </main>`,
    { status },
  );
}

function page(
  title: string,
  body: string,
  opts: {
    description?: string;
    robots?: "index" | "noindex";
    status?: number;
  } = {},
): Response {
  const description = opts.description
    ? `<meta name="description" content="${escapeHtml(opts.description)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(opts.description)}">`
    : "";
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    ...SYSTEM_SECURITY_HEADERS,
  };
  if (opts.robots !== "index") headers["X-Robots-Tag"] = "noindex, nofollow";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${description}<link rel="icon" href="${FAVICON}"><style>
:root{--paper:#f6f4ec;--panel:#fffdf7;--ink:#1f2723;--muted:#68726c;--line:#ddd7c6;--line-soft:#eae6d8;--accent:#0b5d52;--accent-deep:#083f38;--lume:#d8ff4a;--dark:#132420;--dark-2:#0d1b18;--danger:#a33d2e;--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);background-image:radial-gradient(rgba(31,39,35,.03) 1px,transparent 1px);background-size:22px 22px;color:var(--ink);font:16px/1.55 var(--sans)}
a{color:inherit;text-decoration:none}
::selection{background:var(--lume);color:var(--ink)}
h1,h2,h3{font-family:var(--serif);font-weight:600;letter-spacing:-.01em}
.top{height:64px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4vw,48px);background:var(--paper);position:sticky;top:0;z-index:5}
.brand{font:700 17px var(--serif);display:inline-flex;align-items:center;gap:9px}
.brand::before{content:"";width:20px;height:20px;border-radius:5.5px;flex:none;background:url("${FAVICON}") center/contain no-repeat;box-shadow:0 1px 4px rgba(19,36,32,.25)}
.top nav{display:flex;gap:6px;align-items:center}
.top nav a{padding:8px 11px;border-radius:5px;color:var(--muted);font-size:14.5px}
.top nav a:hover{background:var(--line-soft);color:var(--ink)}
.top nav a.button{color:#fff}
.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid var(--accent-deep);border-radius:5px;background:var(--accent);color:#fff;padding:0 15px;font:600 14px var(--sans);cursor:pointer;transition:background .15s}
.button:hover,button:hover{background:var(--accent-deep)}
.button.ghost{background:transparent;color:var(--accent);border-color:var(--accent)}
.button.ghost:hover{background:rgba(11,93,82,.08)}
.button.small{min-height:32px;padding:0 11px;font-size:13px}
.button.danger,button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
.button.danger:hover,button.danger:hover{background:rgba(163,61,46,.08)}
.eyebrow{font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.16em;color:var(--accent);margin:0 0 10px}
.eyebrow::before{content:"// "}
.muted{color:var(--muted)}
.mini{font-size:12.5px;color:var(--muted);margin:7px 0 0}
.error{color:var(--danger)}
label{display:block;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px}
input,select,textarea{width:100%;min-height:38px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:8px 10px;font:14px var(--sans);color:var(--ink);text-transform:none;letter-spacing:0}
textarea{resize:vertical;font:12.5px/1.55 var(--mono)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--lume);outline-offset:0;border-color:var(--accent)}
.home{max-width:1120px;margin:0 auto;padding:0 clamp(18px,4vw,34px) 8px}
.hero{display:grid;grid-template-columns:minmax(0,1.04fr) minmax(0,.96fr);gap:clamp(28px,4vw,52px);align-items:start;padding:clamp(48px,7vh,84px) 0 clamp(44px,6vh,68px)}
.hero .term{margin-top:34px}
.hero h1{font-size:clamp(34px,4.4vw,54px);line-height:1.06;margin:12px 0 0}
.lead{font-size:17.5px;line-height:1.65;color:var(--muted);max-width:54ch;margin:18px 0 0}
.actions{display:flex;gap:12px;margin-top:36px;flex-wrap:wrap}
.rise{animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
.d1{animation-delay:.06s}.d2{animation-delay:.14s}.d3{animation-delay:.22s}.d4{animation-delay:.32s}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes blink{50%{opacity:0}}
.term{background:var(--dark);border:1px solid #24443c;border-radius:10px;box-shadow:0 24px 48px -20px rgba(19,36,32,.5);overflow:hidden}
.term-bar{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid rgba(232,240,233,.12);color:#8fa79d;font:600 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase}
.term-bar i{width:9px;height:9px;border-radius:50%;background:#2c4b42}
.term-bar i:first-child{background:var(--lume)}
.term-bar span{margin-left:auto}
.term pre{margin:0;padding:18px 18px 22px;font:13px/1.75 var(--mono);color:#e6efe8;white-space:pre-wrap;word-break:break-word}
.t-dim{color:#748c81}.t-ok{color:var(--lume)}.t-url{color:#8ce0cf}
.caret{display:inline-block;width:8px;height:14px;background:var(--lume);vertical-align:-2px;margin-left:3px;animation:blink 1.1s steps(1) infinite}
.steps{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.steps section{padding:26px clamp(16px,2.5vw,28px) 30px;border-right:1px solid var(--line)}
.steps section:last-child{border-right:0}
.step-n{display:block;font:600 12px var(--mono);color:var(--accent);letter-spacing:.12em;margin-bottom:12px}
.steps h3{font-size:20px;margin:0 0 8px}
.steps p{margin:0;font-size:14.5px;line-height:1.6;color:var(--muted)}
.feat{margin:104px 0 96px}
.feat-head h2{font-size:clamp(24px,2.6vw,30px);margin:8px 0 0}
.feat-head{margin-bottom:36px}
.frow{display:grid;grid-template-columns:52px minmax(0,1fr) 232px;gap:clamp(18px,3vw,44px);align-items:center;padding:26px 0;border-top:1px solid var(--line)}
.frow:last-of-type{border-bottom:1px solid var(--line)}
.fnum{font:600 13px var(--mono);color:var(--accent);letter-spacing:.1em}
.fcopy strong{display:block;font:600 16.5px var(--serif);margin-bottom:4px}
.fcopy span{display:block;font-size:13.5px;line-height:1.6;color:var(--muted);max-width:58ch}
.fviz svg{width:100%;height:auto;display:block}
.fviz .db{fill:var(--panel);stroke:var(--ink);stroke-width:1.2}
.fviz .da{fill:var(--accent)}
.fviz .dd{stroke:var(--muted);stroke-width:1.2;stroke-dasharray:3 4;fill:none}
.fviz .dln{stroke:var(--line);stroke-width:3;stroke-linecap:round;fill:none}
.fviz .dl{font:600 9px var(--mono);fill:var(--muted)}
.fviz .dlk{font:600 9px var(--mono);fill:var(--accent-deep)}
.fviz .dw9{font:600 9px var(--mono);fill:#fff}
.fviz .dt{font:600 9.5px var(--mono)}
.loop{padding:56px 0 0}
.loop-flow{margin:-4px 0 56px}
.loop-flow svg{width:100%;height:auto;display:block;overflow:visible}
.loop-ribbon{font:700 17px var(--mono);letter-spacing:.14em;fill:var(--accent-deep)}
.loop-head{margin-bottom:44px}
.loop-head>*{min-width:0;max-width:100%}
.loop-head h2{font-size:clamp(26px,3vw,34px);margin:8px 0 12px}
.loop-head .muted{max-width:60ch;font-size:15.5px;line-height:1.65;margin:0}
.story{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.25fr);gap:clamp(26px,4.5vw,60px);align-items:center;margin:0;padding:40px 0}
.story.flip{grid-template-columns:minmax(0,1.25fr) minmax(0,.9fr)}
.story+.story{border-top:1px dashed var(--line)}
.story .vid{border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 36px -22px rgba(19,36,32,.5);transition:border-color .15s,transform .15s}
.story:hover .vid{border-color:var(--accent);transform:translateY(-2px)}
.story.flip .story-copy{order:2}
.story-copy h3{font:600 22px var(--serif);margin:6px 0 8px}
.story-copy>p:not(.eyebrow){margin:0 0 14px;font-size:14.5px;line-height:1.6;color:var(--muted)}
.story-steps{list-style:none;margin:0;padding:0;display:grid;gap:11px;counter-reset:ss}
.story-steps li{counter-increment:ss;font:14px/1.55 var(--sans);color:var(--ink);display:flex;gap:12px;align-items:baseline}
.story-steps li::before{content:counter(ss,decimal-leading-zero);font:600 10.5px var(--mono);color:var(--accent);min-width:18px}
.story .vid{cursor:zoom-in}
.vidmodal{border:0;padding:0;background:transparent;width:min(1120px,94vw,152vh);overflow:visible}
.vidmodal::backdrop{background:rgba(13,27,24,.74);backdrop-filter:blur(5px)}
.vidmodal video{width:100%;aspect-ratio:16/9;display:block;border-radius:14px;background:var(--dark);box-shadow:0 48px 110px -34px rgba(0,0,0,.65)}
.vm-close{position:absolute;top:-14px;right:-14px;z-index:1;width:34px;height:34px;border-radius:50%;border:1px solid rgba(232,240,233,.25);background:var(--dark);color:#e6efe8;font:400 19px/1 var(--sans);cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)}
.vm-close:hover{background:#1d3a33}
.vid{position:relative;display:block;aspect-ratio:16/9;background:var(--dark);overflow:hidden}
.vid video{width:100%;height:100%;object-fit:cover;display:block}
.showcase{padding:0 0 104px}
.show-head{margin-bottom:36px}
.show-head h2{font-size:clamp(24px,2.6vw,30px);margin:8px 0 12px}
.show-head .muted{max-width:60ch;font-size:15px;line-height:1.65;margin:0}
.show-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.show-card{display:flex;flex-direction:column;gap:9px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 0 18px;overflow:hidden;transition:border-color .15s,transform .15s,box-shadow .15s}
.show-card>strong,.show-card>span,.show-card>div,.show-card>em{margin:0 18px}
.show-card .vid{margin:0 0 6px;border-bottom:1px solid var(--line-soft)}
.show-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 14px 28px -18px rgba(19,36,32,.4)}
.show-card strong{font:600 17px var(--serif)}
.show-card span{font-size:13.5px;line-height:1.55;color:var(--muted);flex:1}
.show-card i{font:600 10.5px var(--mono);font-style:normal;text-transform:uppercase;letter-spacing:.06em;background:var(--line-soft);color:var(--muted);border-radius:999px;padding:2px 8px;margin:0 4px 4px 0;display:inline-block}
.show-card em{font:600 12.5px var(--mono);font-style:normal;color:var(--accent)}
.show-card:hover em{color:var(--accent-deep)}
.agents{background:var(--dark);color:#e6efe8;border-radius:12px;padding:clamp(30px,5vw,56px);display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:clamp(22px,3.5vw,40px)}
.agents .eyebrow{color:var(--lume)}
.agents h2{font-size:clamp(24px,2.6vw,30px);margin:8px 0 12px;color:#fff}
.agents p{color:#9db3a9;font-size:15px;line-height:1.7;margin:0 0 18px;max-width:52ch}
.agents a{color:#8ce0cf;text-decoration:underline dotted}
.codeblock{position:relative;background:var(--dark-2);border:1px solid rgba(232,240,233,.14);border-radius:8px;margin-top:12px}
.codeblock pre{margin:0;padding:14px 16px;font:12.5px/1.6 var(--mono);color:#cfe3d8;overflow-x:auto}
.copy-btn{position:absolute;top:8px;right:8px;min-height:26px;padding:0 9px;font:600 11px var(--mono);border-radius:4px;border:1px solid rgba(232,240,233,.25);background:rgba(232,240,233,.06);color:#cfe3d8;cursor:pointer}
.copy-btn:hover{background:rgba(232,240,233,.14)}
.copy-btn.copied{border-color:var(--lume);color:var(--lume);background:transparent}
.copy-lite{position:absolute;top:8px;right:8px;min-height:26px;padding:0 9px;font:600 11px var(--mono);border-radius:4px;border:1px solid var(--line);background:#fff;color:var(--muted);cursor:pointer}
.copy-lite:hover{color:var(--ink);border-color:var(--accent);background:#fff}
.copy-lite.copied{color:var(--accent);border-color:var(--accent);background:#fff}
.copywrap{position:relative}
footer.site{border-top:1px solid var(--line);margin-top:88px;padding:32px 0 52px;display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13.5px}
footer.site nav{display:flex;gap:18px;flex-wrap:wrap}
footer.site a:hover{color:var(--ink)}
footer.site code{font:12px var(--mono)}
.legal{max-width:840px;margin:0 auto;padding:clamp(34px,6vw,68px) clamp(18px,4vw,34px) 28px}
.legal h1{font-size:clamp(32px,4.2vw,48px);line-height:1.08;margin:8px 0 8px}
.legal h2{font-size:24px;margin:34px 0 10px;padding-top:4px;border-top:1px solid var(--line)}
.legal p,.legal li{color:var(--muted);font-size:15.5px;line-height:1.72}
.legal p{margin:0 0 14px}
.legal ul{margin:0 0 18px;padding-left:22px}
.legal li{margin:8px 0}
.legal strong{color:var(--ink)}
.legal a{text-decoration:underline dotted;color:var(--accent)}
.legal .updated{font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:26px}
.legal-foot{max-width:840px;margin-left:auto;margin-right:auto;padding-left:clamp(18px,4vw,34px);padding-right:clamp(18px,4vw,34px)}
.admin{max-width:1180px;margin:0 auto;padding:30px clamp(18px,4vw,34px) 72px}
.headline{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:20px;border-bottom:2px solid var(--ink)}
.headline h1{font-size:clamp(28px,3.2vw,38px);margin:8px 0 4px}
.headline .muted{font-size:14px}
.metrics{display:flex;flex-wrap:wrap;border:1px solid var(--line);background:var(--panel)}
.metrics div{padding:12px 18px 11px;border-right:1px solid var(--line);min-width:84px}
.metrics div:last-child{border-right:0}
.metrics strong{display:block;font:600 22px/1.1 var(--serif);font-variant-numeric:tabular-nums}
.metrics span{display:block;font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:5px}
.setup,.team-panel{display:grid;grid-template-columns:270px minmax(0,1fr);gap:30px;padding:30px 0;border-bottom:1px solid var(--line)}
.setup h2,.team-panel h2{margin:0 0 8px;font-size:23px}
.setup-grid{display:grid;gap:14px}
.token-form{display:grid;grid-template-columns:minmax(170px,1fr) 130px auto;gap:10px;align-items:end;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.connect-strip{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:13px 16px;margin-top:24px}
.connect-strip strong{display:block;font-size:14.5px;margin-bottom:2px}
.connect-strip .muted{font-size:13px}
.connect-strip code{font:12px var(--mono)}
.strip-actions{display:flex;gap:8px;flex-wrap:wrap;white-space:nowrap}
.quick-prompt{border:1px dashed var(--accent);background:var(--panel);border-radius:8px;padding:14px}
.quick-prompt label{margin:0 0 8px;color:var(--accent);font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.1em}
.quick-prompt textarea{min-height:200px}
.quick-prompt .mini{margin-bottom:0}
.setup-paths{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.path-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.path-head{margin:0 0 8px;font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--accent)}
.path-for{color:var(--muted);letter-spacing:.04em;text-transform:none;font-weight:500;margin-left:6px}
.path-card .mini{margin:8px 0 0}
.path-card .copywrap{margin-top:8px}
.token-form label{margin:0 0 6px}
.token-list{list-style:none;margin:6px 0 0;padding:0}
.token-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--line-soft);padding:8px 2px;font-size:13.5px}
.token-list li small{display:block;color:var(--muted);margin-top:2px}
.token-list form{margin:0}
details.manual{border:1px solid var(--line);border-radius:8px;background:var(--panel)}
details.manual summary{cursor:pointer;padding:12px 14px;font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--accent)}
details.manual .setup-grid{padding:2px 14px 16px}
.activity-viz{margin-top:22px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px 12px}
.viz-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.viz-head .eyebrow{margin:0}
.viz-head .muted{font-size:13px;font-variant-numeric:tabular-nums}
.chart{height:96px;display:flex;gap:2px;align-items:flex-end;margin-top:12px;border-bottom:1px solid var(--line)}
.chart span{flex:1;min-height:2px;background:var(--accent);border-radius:2px 2px 0 0;opacity:.85}
.chart span:hover{background:var(--accent-deep);opacity:1}
.chart span.zero{background:var(--line-soft)}
.chart-axis{display:flex;justify-content:space-between;color:var(--muted);font:10.5px var(--mono);margin-top:6px}
.art-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:28px 0 10px;flex-wrap:wrap}
.art-toolbar h2{margin:0;font-size:23px;display:flex;align-items:center;gap:10px}
.art-toolbar input{max-width:260px;min-height:34px;font-size:13.5px}
.art-table{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.art-head,.art-tr{display:grid;grid-template-columns:minmax(220px,1.7fr) 110px 74px 60px 110px 96px;gap:12px;align-items:center;padding:8px 14px}
.art-head{color:var(--muted);font:600 10.5px var(--mono);text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid var(--line);padding-top:11px;padding-bottom:11px}
.art-tr{border-bottom:1px solid var(--line-soft);font-size:13.5px;color:var(--ink)}
.art-tr[hidden]{display:none}
.art-tr:last-of-type{border-bottom:0}
.art-tr:hover{background:rgba(11,93,82,.05)}
.art-tr.active{background:rgba(11,93,82,.09)}
.art-name strong{display:block;font-size:14px;font-weight:600}
.art-name small{display:block;color:var(--muted);font:11.5px var(--mono);margin-top:2px;word-break:break-all}
.num{font-variant-numeric:tabular-nums;text-align:right}
.num em{font-style:normal;color:var(--danger);font-size:11.5px}
.art-date{color:var(--muted);font-size:12px;text-align:right;white-space:nowrap}
.art-none{padding:12px 14px}
.access{display:grid;grid-template-columns:1fr auto;gap:8px}
.setup-page{padding:4px 0 34px}
.loadbar{position:fixed;top:0;left:0;height:3px;width:0;background:var(--lume);box-shadow:0 0 8px var(--lume);z-index:60;animation:loadgrow 1.6s cubic-bezier(.2,.6,.3,1) forwards}
@keyframes loadgrow{10%{width:24%}45%{width:62%}100%{width:88%}}
.skel{background:linear-gradient(100deg,var(--line-soft) 35%,var(--panel) 50%,var(--line-soft) 65%);background-size:200% 100%;animation:shimmer 1.1s linear infinite;border-radius:6px}
@keyframes shimmer{to{background-position:-200% 0}}
.button:active,button:active{transform:translateY(1px)}
.art-tr:active{background:rgba(11,93,82,.12)}
.sheet-scrim{position:fixed;inset:0;background:rgba(19,36,32,.38);z-index:19;cursor:default}
.sheet{position:fixed;top:0;right:0;bottom:0;width:min(540px,94vw);background:var(--paper);border-left:1px solid var(--line);z-index:20;display:flex;flex-direction:column;box-shadow:-28px 0 56px -28px rgba(19,36,32,.5);animation:sheetin .2s ease-out}
@keyframes sheetin{from{transform:translateX(28px);opacity:.5}to{transform:none;opacity:1}}
.sheet-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.sheet-head h2{margin:0 0 5px;font-size:20px}
.sheet-head code{font:12px var(--mono);color:var(--muted);word-break:break-all}
.sheet-close{flex:none;color:var(--muted);padding:5px 11px;border:1px solid var(--line);border-radius:5px;background:var(--paper);font-size:14px}
.sheet-close:hover{color:var(--ink);background:var(--line-soft)}
.sheet-body{overflow-y:auto;padding:16px 20px 34px}
.sheet-body h3{margin:22px 0 10px;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.sheet-actions{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap}
.sheet-actions .access{flex:1;min-width:220px}
.sheet-actions .access select,.sheet-actions .access button{min-height:32px;font-size:13px}
.sheet-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}
.sheet-stats div{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:9px 11px}
.sheet-stats strong{display:block;font:600 17px/1.2 var(--serif);font-variant-numeric:tabular-nums}
.sheet-stats span{font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.bars{height:70px;display:flex;gap:3px;align-items:flex-end;border-bottom:1px solid var(--line)}
.bars span{flex:1;min-height:4px;background:var(--accent);border-radius:2px 2px 0 0}
.bars span:hover{background:var(--accent-deep)}
.detail-list,.activity-feed{list-style:none;margin:0;padding:0}
.detail-list li,.activity-feed li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line-soft);padding:8px 0;font-size:13px}
.detail-list li small,.activity-feed li small{display:block;color:var(--muted);margin-top:3px;word-break:break-word}
.detail-list time,.activity-feed time{color:var(--muted);white-space:nowrap;font:11.5px var(--mono)}
.links-list form{margin:0}
.share-create{display:grid;grid-template-columns:minmax(120px,1fr) minmax(90px,1fr) 70px;gap:8px;margin-top:10px}
.share-create button{grid-column:1/-1;white-space:nowrap}
.meta-list{display:grid;gap:7px;margin:0}
.meta-list div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px}
.meta-list dt{color:var(--muted);font-size:12px}
.meta-list dd{margin:0;font-size:13px}
.allowlist-form{display:grid;gap:8px}
.activity{padding-top:26px}
.activity h2{margin:0 0 10px;font-size:23px}
.empty{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:24px}
.small-empty{padding:10px;font-size:13px}
.empty strong,.empty span{display:block}
.empty span{color:var(--muted);margin-top:6px}
.onboard{border:1px dashed var(--accent);background:var(--panel);border-radius:10px;padding:clamp(20px,3vw,30px);margin-top:26px}
.onboard h2{margin:0 0 6px;font-size:24px}
.onboard ol{list-style:none;counter-reset:ob;margin:18px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.onboard li{counter-increment:ob;font-size:14px;line-height:1.6;color:var(--muted)}
.onboard li::before{content:"0" counter(ob);display:block;font:600 12px var(--mono);letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.onboard li strong{display:block;color:var(--ink);font-size:15px;margin-bottom:4px}
.onboard .actions{margin-top:22px}
.pill{display:inline-flex;align-items:center;min-height:26px;border-radius:999px;background:var(--line-soft);color:var(--muted);font:600 11px var(--mono);padding:0 10px}
.panel.narrow{max-width:560px;margin:10vh auto;padding:34px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.code-big{display:inline-block;font:600 24px var(--mono);letter-spacing:.14em;background:#fff;border:1px dashed var(--accent);border-radius:8px;padding:10px 16px;margin:10px 0}
.code-input{font:600 22px var(--mono);letter-spacing:.14em;text-transform:uppercase;text-align:center;min-height:54px;border-style:dashed;border-color:var(--accent)}
.prompt-block textarea{min-height:300px}
.team-body{display:grid;gap:14px;align-content:start}
.team-invite{display:grid;grid-template-columns:minmax(190px,1fr) 140px 110px auto;gap:10px;align-items:end}
.team-invite label{margin:0 0 6px}
.team-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.team-grid h3{margin:10px 0;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.error-box{color:#8f2f26;border-color:#e3b7af;background:#fff8f6}
.invite-list form{margin:0}
@media(max-width:640px){.top nav a:not(.button):not([href="/login"]){display:none}}
@media(max-width:940px){.hero{grid-template-columns:1fr;padding-top:34px}.steps,.show-grid{grid-template-columns:1fr}.story,.story.flip{grid-template-columns:1fr;gap:16px}.story .vid{order:-1}.hero .term{margin-top:0}.frow{grid-template-columns:32px minmax(0,1fr);row-gap:12px}.fviz{grid-column:2;max-width:280px}.loop-head{flex-direction:column;align-items:flex-start}.steps section{border-right:0;border-bottom:1px solid var(--line)}.steps section:last-child{border-bottom:0}.agents{grid-template-columns:1fr}.headline{flex-direction:column;align-items:flex-start}.setup,.team-panel,.team-grid,.team-invite,.token-form,.setup-paths{grid-template-columns:1fr}.access,.share-create{grid-template-columns:1fr}.onboard ol{grid-template-columns:1fr}.metrics div{flex:1 1 33%;border-bottom:1px solid var(--line)}.art-head{display:none}.art-tr{grid-template-columns:minmax(0,1fr) 70px}.art-gate,.art-7d,.art-fb,.art-date{display:none}.art-toolbar input{max-width:none;width:100%}.sheet-stats{grid-template-columns:1fr 1fr}}
</style></head><body>${body}${COPY_SCRIPT}</body></html>`,
    { status: opts.status || 200, headers },
  );
}
