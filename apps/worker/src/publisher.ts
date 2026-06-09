import type {
  Artifact,
  Creator,
  Env,
  GateLevel,
  PublisherSession,
} from "./types";
import { readCookie } from "./auth";
import { ensureTenant, updateArtifactAccess } from "./db";
import {
  assertSlug,
  error,
  escapeHtml,
  GATE_LEVELS,
  isSlug,
  json,
  nowSec,
  randomId,
} from "./util";

const SESSION_COOKIE = "au_pub";
const STATE_COOKIE = "au_state";

type ArtifactRow = Artifact & {
  total_views: number;
  unique_viewers: number;
  share_links: number;
  last_view_ts: number | null;
};

export async function renderHome(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getPublisherSession(request, env);
  const signedIn = Boolean(session);
  return page(
    "Artifact Use",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav>
        ${signedIn ? `<a href="/admin">Admin</a><a href="/logout">Sign out</a>` : `<a href="/login">Sign in</a><a class="button small" href="/signup">Sign up</a>`}
      </nav>
    </header>
    <main class="home">
      <section class="hero">
        <div>
          <p class="eyebrow">Cloudflare artifact publishing</p>
          <h1>Publish static artifacts from agents without sharing Cloudflare keys.</h1>
          <p class="lead">Tenant paths, WorkOS publisher auth, DocSend-style gates, and HTTP MCP for Claude Code, Codex, and other coding agents.</p>
          <div class="actions">
            <a class="button" href="/signup">Sign up</a>
            <a class="button ghost" href="/login">Sign in</a>
          </div>
        </div>
        <div class="status" aria-label="Service status">
          <span></span>
          <strong>Hosted at ${escapeHtml(new URL(env.SITE_BASE_URL).host)}</strong>
          <em>${escapeHtml(env.SITE_BASE_URL)}/tenant/artifact/</em>
        </div>
      </section>
    </main>`,
  );
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
  if (path === "/callback" && request.method === "GET")
    return finishAuth(request, env);
  if (path === "/logout" && request.method === "GET") {
    return redirect("/login", {
      "Set-Cookie": expireCookie(SESSION_COOKIE),
    });
  }
  return error(405, "method_not_allowed", "method not allowed");
}

export async function handlePublisherAdmin(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const session = await getPublisherSession(request, env);
  if (!session) return redirect("/login");
  if (path === "/admin" && request.method === "GET")
    return renderAdmin(env, session);
  if (path === "/admin/tenant" && request.method === "POST")
    return updateTenant(request, env, session);
  if (path === "/admin/artifact/access" && request.method === "POST")
    return updateAccess(request, env, session);
  if (path === "/admin/me" && request.method === "GET")
    return json({ publisher: publicSession(session) });
  return error(404, "not_found", "publisher admin route not found");
}

async function startAuth(
  env: Env,
  screenHint: "sign-in" | "sign-up",
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
  return redirect(url.toString(), {
    "Set-Cookie": cookie(STATE_COOKIE, state, 10 * 60),
  });
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
  if (!code) return error(400, "code_required", "code is required");
  if (!state || state !== readCookie(request, STATE_COOKIE))
    return error(400, "invalid_state", "sign in state is invalid");
  if (!env.WORKOS_CLIENT_ID || !env.WORKOS_API_KEY)
    return error(500, "workos_not_configured", "WorkOS auth is not configured");

  const auth = await exchangeCode(request, env, code);
  const user = (auth.user || {}) as Record<string, unknown>;
  const userId = stringClaim(user.id) || stringClaim(auth.user_id);
  const email = stringClaim(user.email) || stringClaim(auth.email);
  const orgId =
    stringClaim(auth.organization_id) ||
    stringClaim(auth.organizationId) ||
    (userId ? `user:${userId}` : email ? `email:${email}` : "");
  if (!orgId || !userId)
    return error(401, "invalid_workos_response", "WorkOS response is missing user identity");
  const name = [stringClaim(user.first_name), stringClaim(user.last_name)]
    .filter(Boolean)
    .join(" ");
  const session: PublisherSession = {
    sub: userId,
    orgId,
    email,
    name: name || stringClaim(user.email) || null,
    exp: nowSec() + 7 * 86400,
  };
  return redirect("/admin", {
    "Set-Cookie": cookie(
      SESSION_COOKIE,
      await signSession(session, env),
      7 * 86400,
    ),
  });
}

async function exchangeCode(
  request: Request,
  env: Env,
  code: string,
): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.workos.com/user_management/authenticate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WORKOS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      code,
      ip_address: request.headers.get("CF-Connecting-IP") || undefined,
      user_agent: request.headers.get("User-Agent") || undefined,
    }),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(
      `WorkOS auth failed: ${res.status} ${String(parsed.error || parsed.code || text)}`,
    );
  }
  return parsed;
}

async function renderAdmin(
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const tenant = await env.DB.prepare(
    "SELECT * FROM tenants WHERE org_id = ?",
  )
    .bind(session.orgId)
    .first<{ slug: string; name: string | null; owner_email: string | null }>();
  const rows = await env.DB.prepare(
    `SELECT a.*,
      COUNT(DISTINCT v.id) AS total_views,
      COUNT(DISTINCT v.email) AS unique_viewers,
      MAX(v.ts) AS last_view_ts,
      COUNT(DISTINCT sl.id) AS share_links
     FROM artifacts a
     LEFT JOIN views v ON v.artifact_id = a.id
     LEFT JOIN share_links sl ON sl.artifact_id = a.id
     WHERE a.org_id = ?
     GROUP BY a.id
     ORDER BY a.updated_at DESC`,
  )
    .bind(session.orgId)
    .all<ArtifactRow>();
  const artifacts = rows.results || [];
  const totalViews = artifacts.reduce((sum, row) => sum + Number(row.total_views || 0), 0);
  const uniqueViewers = new Set<string>();
  const uniqueRows = await env.DB.prepare(
    `SELECT DISTINCT v.email
     FROM views v JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.org_id = ?`,
  )
    .bind(session.orgId)
    .all<{ email: string }>();
  for (const row of uniqueRows.results || []) uniqueViewers.add(row.email);

  return page(
    "Publisher Admin",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav><a href="/admin">Admin</a><a href="/logout">Sign out</a></nav>
    </header>
    <main class="admin">
      <section class="headline">
        <div>
          <p class="eyebrow">Publisher admin</p>
          <h1>${escapeHtml(tenant?.name || tenant?.slug || session.name || session.email || "Publisher")}</h1>
          <p class="muted">${escapeHtml(session.email || session.sub)} · ${escapeHtml(session.orgId)}</p>
        </div>
        <div class="metrics">
          <div><strong>${artifacts.length}</strong><span>Artifacts</span></div>
          <div><strong>${totalViews}</strong><span>Views</span></div>
          <div><strong>${uniqueViewers.size}</strong><span>Viewers</span></div>
        </div>
      </section>
      <section class="toolbar">
        <form method="post" action="/admin/tenant">
          <label>Tenant slug</label>
          <div class="inline">
            <input name="tenant" pattern="[a-z0-9][a-z0-9-]{0,62}" value="${escapeHtml(tenant?.slug || suggestedSlug(session.email || session.sub))}" required>
            <input name="name" value="${escapeHtml(tenant?.name || "")}" placeholder="Display name">
            <button type="submit">Save</button>
          </div>
        </form>
      </section>
      <section class="table">
        <div class="table-head"><span>Artifact</span><span>Access</span><span>Views</span><span></span></div>
        ${
          artifacts.length
            ? artifacts.map((artifact) => artifactRow(env, artifact)).join("")
            : `<div class="empty"><strong>No artifacts yet.</strong><span>Published artifacts from MCP or the CLI will appear here.</span></div>`
        }
      </section>
    </main>`,
  );
}

function artifactRow(env: Env, artifact: ArtifactRow): string {
  const url = `${env.SITE_BASE_URL}/${artifact.tenant_slug}/${artifact.slug}/`;
  return `<article class="artifact-row">
    <div>
      <strong>${escapeHtml(artifact.title)}</strong>
      <span>${escapeHtml(artifact.tenant_slug)}/${escapeHtml(artifact.slug)}</span>
    </div>
    <form method="post" action="/admin/artifact/access" class="access">
      <input type="hidden" name="tenant" value="${escapeHtml(artifact.tenant_slug)}">
      <input type="hidden" name="artifact" value="${escapeHtml(artifact.slug)}">
      <select name="gate_level">
        ${["public", "email", "verified_email", "allowlist"].map((level) => `<option value="${level}"${artifact.gate_level === level ? " selected" : ""}>${level}</option>`).join("")}
      </select>
      <button type="submit">Update</button>
    </form>
    <div class="views">
      <strong>${Number(artifact.total_views || 0)}</strong>
      <span>${Number(artifact.unique_viewers || 0)} unique</span>
    </div>
    <a class="button small ghost" href="${escapeHtml(url)}">Open</a>
  </article>`;
}

async function updateTenant(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const slug = assertSlug("tenant", String(form.get("tenant") || ""));
  const creator = creatorFromSession(session);
  await ensureTenant(env, creator, slug, String(form.get("name") || "") || null);
  return redirect("/admin");
}

async function updateAccess(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const tenantSlug = assertSlug("tenant", String(form.get("tenant") || ""));
  const artifactSlug = assertSlug("artifact", String(form.get("artifact") || ""));
  const gateLevel = String(form.get("gate_level") || "") as GateLevel;
  if (!GATE_LEVELS.has(gateLevel))
    return error(400, "invalid_gate_level", "gate_level is not supported");
  const artifact = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE tenant_slug = ? AND slug = ? AND org_id = ?",
  )
    .bind(tenantSlug, artifactSlug, session.orgId)
    .first<Artifact>();
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  await updateArtifactAccess(env, artifact, null, gateLevel, undefined);
  return redirect("/admin");
}

function creatorFromSession(session: PublisherSession): Creator {
  return {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    permissions: new Set(["artifacts:admin"]),
    raw: { publisher_session: true },
  };
}

async function getPublisherSession(
  request: Request,
  env: Env,
): Promise<PublisherSession | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const session = await verifySession(raw, env);
  if (!session || session.exp < nowSec()) return null;
  return session;
}

function publicSession(session: PublisherSession): Record<string, unknown> {
  return {
    sub: session.sub,
    org_id: session.orgId,
    email: session.email,
    name: session.name,
    exp: session.exp,
  };
}

async function signSession(
  session: PublisherSession,
  env: Env,
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function verifySession(
  raw: string,
  env: Env,
): Promise<PublisherSession | null> {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (expected !== sig) return null;
  return JSON.parse(
    new TextDecoder().decode(fromBase64Url(payload)),
  ) as PublisherSession;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return base64Url(new Uint8Array(sig));
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function expireCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...headers },
  });
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function suggestedSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .split("@")[0]!
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return isSlug(slug) ? slug : "publisher";
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{--ink:#17201d;--muted:#65736d;--line:#d8dfdc;--paper:#fbfcfa;--panel:#fff;--field:#f4f7f5;--accent:#0b6f5f;--accent2:#d6ff62}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Aptos,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}a{color:inherit;text-decoration:none}.top{height:66px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4vw,48px);background:rgba(251,252,250,.92);position:sticky;top:0;z-index:5}.brand{font-weight:800}.top nav{display:flex;gap:10px;align-items:center}.top nav a{padding:9px 10px;border-radius:6px;color:var(--muted)}.top nav a:hover{background:var(--field);color:var(--ink)}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;padding:0 14px;font:700 14px inherit;cursor:pointer}.button.ghost{background:transparent;color:var(--accent)}.button.small{min-height:34px;padding:0 11px}.home,.admin{max-width:1120px;margin:0 auto;padding:clamp(26px,5vw,56px) clamp(18px,4vw,34px)}.hero{min-height:calc(100vh - 150px);display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:44px;align-items:center}.eyebrow{font-size:12px;font-weight:800;text-transform:uppercase;color:var(--accent);margin:0 0 14px}.hero h1,.headline h1{font-size:clamp(36px,6vw,74px);line-height:.96;margin:0;max-width:780px}.lead{font-size:20px;line-height:1.5;color:var(--muted);max-width:680px}.actions{display:flex;gap:12px;margin-top:26px}.status{border-left:3px solid var(--accent);padding:18px 0 18px 20px}.status span{display:block;width:10px;height:10px;border-radius:50%;background:var(--accent2);box-shadow:0 0 0 5px rgba(214,255,98,.28);margin-bottom:16px}.status strong,.status em{display:block}.status em{margin-top:8px;color:var(--muted);font-style:normal;word-break:break-all}.headline{display:flex;align-items:end;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line);padding-bottom:26px}.headline h1{font-size:clamp(32px,4vw,54px)}.muted{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(3,110px);border:1px solid var(--line);background:var(--panel)}.metrics div{padding:16px;border-right:1px solid var(--line)}.metrics div:last-child{border-right:0}.metrics strong{display:block;font-size:26px}.metrics span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.toolbar{padding:24px 0;border-bottom:1px solid var(--line)}label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;color:var(--muted);margin-bottom:8px}.inline{display:grid;grid-template-columns:minmax(160px,260px) minmax(160px,1fr) auto;gap:10px}input,select{width:100%;min-height:38px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:8px 10px;font:inherit}.table{margin-top:22px}.table-head,.artifact-row{display:grid;grid-template-columns:minmax(240px,1fr) 310px 120px 82px;gap:14px;align-items:center}.table-head{padding:0 12px 10px;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase}.artifact-row{background:#fff;border:1px solid var(--line);padding:12px;margin-bottom:10px}.artifact-row strong,.artifact-row span{display:block}.artifact-row span,.views span{color:var(--muted);font-size:13px;margin-top:3px}.access{display:grid;grid-template-columns:1fr auto;gap:8px}.empty{border:1px solid var(--line);background:#fff;padding:24px}.empty strong,.empty span{display:block}.empty span{color:var(--muted);margin-top:6px}.panel.narrow{max-width:520px;margin:14vh auto;padding:32px}.error{color:#a33434}@media(max-width:760px){.hero{grid-template-columns:1fr;min-height:auto}.headline{align-items:start;flex-direction:column}.metrics{grid-template-columns:repeat(3,minmax(0,1fr));width:100%}.inline,.table-head,.artifact-row{grid-template-columns:1fr}.table-head{display:none}.access{grid-template-columns:1fr}.actions{flex-wrap:wrap}}
</style></head><body>${body}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}
