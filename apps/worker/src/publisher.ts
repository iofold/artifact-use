import type {
  Artifact,
  Creator,
  Env,
  GateLevel,
  PublisherSession,
} from "./types";
import {
  extractStringArray,
  fromBase64Url,
  mintCreatorToken,
  readCookie,
  signPayload,
  userScopedOrgId,
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

type AdminMaps = {
  shares: Map<string, AdminShareLink[]>;
  comments: Map<string, AdminComment[]>;
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

export async function renderHome(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getPublisherSession(request, env);
  if (session) return renderAdmin(request, env, session);
  const base = siteBaseUrl(env);
  const prefix = artifactPathPrefix(env) || "";
  return page(
    "Artifact Use — publish agent output as review-ready links",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav>
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
          <p class="lead rise d2">Your coding agent publishes HTML tools, dashboards, PDFs, and whole static folders to one stable URL — with access gates, versioning, and comments built in.</p>
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
      <section class="steps" aria-label="How it works">
        <section>
          <span class="step-n">01</span>
          <h3>Agents publish</h3>
          <p>Over MCP, CLI, or plain HTTP — single HTML files or complete folders with images, data, and PDFs. Versions are immutable and promoted atomically.</p>
        </section>
        <section>
          <span class="step-n">02</span>
          <h3>People review</h3>
          <p>One stable link behind an email, verified-email, or allowlist gate. Reviewers comment directly on the artifact — no extra tooling.</p>
        </section>
        <section>
          <span class="step-n">03</span>
          <h3>Work loops back</h3>
          <p>Views and feedback are readable through the same API, so the next agent iteration starts where the review ended.</p>
        </section>
      </section>
      <section class="feat" aria-label="What you get">
        <div><strong>Stable links</strong><span>${escapeHtml(prefix)}/{slug}-{code}/ URLs that survive every republish.</span></div>
        <div><strong>Access gates</strong><span>Public, email, verified email, or per-domain and per-address allowlists.</span></div>
        <div><strong>Feedback</strong><span>Comments with element anchors, replies, and resolve/reopen — on the artifact itself.</span></div>
        <div><strong>Agent-first API</strong><span>HTTP MCP with OAuth or bearer tokens, a JSON-first CLI, and machine descriptors for every artifact.</span></div>
        <div><strong>Your infrastructure</strong><span>MIT licensed; runs on your Cloudflare account with R2 and D1. Agents never hold Cloudflare credentials.</span></div>
        <div><strong>Team workspaces</strong><span>Invite teammates — everyone shares the same artifact list, stats, and feedback.</span></div>
      </section>
      <section class="agents" id="agents">
        <div>
          <p class="eyebrow">Built for agents first</p>
          <h2>Your agent can set itself up.</h2>
          <p>Point any MCP-capable agent at the endpoint and it authenticates with OAuth — or it requests a token and asks you to approve a one-time code, with no browser on its side.</p>
          <p>Everything here is machine-readable. Agents start at <a href="/llms.txt">${escapeHtml(base)}/llms.txt</a>.</p>
        </div>
        <div>
          <div class="codeblock"><button class="copy-btn" type="button" data-copy="mcp-config">Copy</button><pre id="mcp-config">${escapeHtml(mcpConfig(env))}</pre></div>
          <div class="codeblock"><button class="copy-btn" type="button" data-copy="connect-snippet">Copy</button><pre id="connect-snippet"><span class="t-dim"># tokenless agents: device-style connect</span>
POST ${escapeHtml(base)}/api/v1/connect/start
<span class="t-dim"># -> human approves the code at ${escapeHtml(base)}/connect</span>
POST ${escapeHtml(base)}/api/v1/connect/poll
<span class="t-dim"># -> bearer token + ready-to-run setup prompt</span></pre></div>
        </div>
      </section>
      <footer class="site">
        <span>Artifact Use · MIT licensed</span>
        <nav>
          <a href="${GITHUB_URL}">GitHub</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">Agent guide</a>
          <code>MCP ${escapeHtml(base)}/mcp</code>
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
  const session = await getPublisherSession(request, env);
  if (!session) {
    // Browsers get the sign-in redirect; agents get instructions instead of
    // a dead-end 302 (same pattern as the artifact gate JSON).
    if (!wantsHtml(request)) return adminGateJson(env);
    return redirect("/login");
  }
  if (path === "/admin" && request.method === "GET")
    return renderAdmin(request, env, session);
  if (path === "/admin/super" && request.method === "GET")
    return renderSuperAdmin(request, env, session);
  if (path === "/admin/super/transfer" && request.method === "POST")
    return transferArtifactOwner(request, env, session);
  if (path === "/admin/artifact/access" && request.method === "POST")
    return updateAccess(request, env, session);
  if (path === "/admin/artifact/share-link" && request.method === "POST")
    return createAdminShareLink(request, env, session);
  if (path === "/admin/artifact/share-link/revoke" && request.method === "POST")
    return revokeAdminShareLink(request, env, session);
  if (
    (path === "/admin/agent-prompt" || path === "/admin/creator-token") &&
    request.method === "POST"
  )
    return createAgentPrompt(request, env, session);
  if (path === "/admin/agent-token/revoke" && request.method === "POST")
    return revokeAgentToken(request, env, session);
  if (path === "/admin/team/invite" && request.method === "POST")
    return createPublisherInvite(request, env, session);
  if (path === "/admin/team/invite/revoke" && request.method === "POST")
    return revokePublisherInvite(request, env, session);
  if (path === "/admin/me" && request.method === "GET")
    return json({ publisher: publicSession(session) });
  return error(404, "not_found", "publisher admin route not found");
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
        agent_connect: `no token? POST ${base}/api/v1/connect/start, have your human approve the code at ${base}/connect, then POST ${base}/api/v1/connect/poll for a bearer token`,
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
  if (!code) return error(400, "code_required", "code is required");
  if (!state || state !== readCookie(request, STATE_COOKIE))
    return error(400, "invalid_state", "sign in state is invalid");
  if (!env.WORKOS_CLIENT_ID || !env.WORKOS_API_KEY)
    return error(500, "workos_not_configured", "WorkOS auth is not configured");

  const invitationToken = readCookie(request, INVITE_COOKIE);
  const auth = await exchangeCode(request, env, code, invitationToken);
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
  // Honor a pre-auth destination (e.g. /connect?code=...) set before the
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

async function renderAdmin(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const openId = new URL(request.url).searchParams.get("open") || "";
  const superAdmin = isSuperAdmin(session, env);
  const artifacts = await artifactStatsRows(env, {
    orgId: session.orgId,
    orderBy: "total_views DESC, a.updated_at DESC",
  });
  const maps = await adminMaps(env, session.orgId);
  const team = await adminTeam(env, session);
  const tokens = await listAgentTokens(env, session.orgId);
  const hasArtifacts = artifacts.length > 0;

  // Metrics only mean something once there is something to measure; a new
  // workspace gets the onboarding card instead of a row of zeros.
  let metricsHtml = "";
  if (hasArtifacts) {
    const totalViews = artifacts.reduce(
      (sum, row) => sum + Number(row.total_views || 0),
      0,
    );
    const totalComments = artifacts.reduce(
      (sum, row) => sum + Number(row.comment_count || 0),
      0,
    );
    const views7d = await viewsSince(env, session.orgId, nowSec() - 7 * 86400);
    const uniqueRow = await env.DB.prepare(
      `SELECT COUNT(DISTINCT v.email) AS n
       FROM views v JOIN artifacts a ON a.id = v.artifact_id
       WHERE a.org_id = ?`,
    )
      .bind(session.orgId)
      .first<{ n: number }>();
    metricsHtml = `<div class="metrics">
      <div><strong>${artifacts.length}</strong><span>Artifacts</span></div>
      <div><strong>${formatNumber(totalViews)}</strong><span>Views</span></div>
      <div><strong>${formatNumber(Number(uniqueRow?.n || 0))}</strong><span>Viewers</span></div>
      <div><strong>${formatNumber(views7d)}</strong><span>Views · 7d</span></div>
      <div><strong>${formatNumber(totalComments)}</strong><span>Feedback</span></div>
    </div>`;
  }
  const recent = Array.from(maps.recent.values())
    .flat()
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, 18);

  const artifactsHtml = hasArtifacts
    ? `<section class="table" aria-label="Artifacts">
        <div class="table-head"><span>Artifact</span><span>Public path</span><span>Access</span><span>Stats</span><span></span></div>
        ${artifacts
          .map((artifact) =>
            artifactRow(
              env,
              artifact,
              {
                shares: maps.shares.get(artifact.id) || [],
                comments: maps.comments.get(artifact.id) || [],
                recent: maps.recent.get(artifact.id) || [],
                daily: maps.daily.get(artifact.id) || [],
              },
              openId === artifact.id,
            ),
          )
          .join("")}
      </section>`
    : `<div class="onboard">
        <p class="eyebrow">First artifact</p>
        <h2>Connect an agent and publish something.</h2>
        <ol>
          <li><strong>Connect an agent</strong>Generate a one-paste prompt below — it carries a scoped publish token, so any agent can publish here immediately.</li>
          <li><strong>Ask for an artifact</strong>"Publish this prototype with an email gate." The agent gets back a stable link under ${escapeHtml(artifactPathPrefix(env) || "/")}/.</li>
          <li><strong>Share and review</strong>Send the link around; views and comments land back here and in your agent's API.</li>
        </ol>
        <div class="actions">
          <a class="button" href="#agent-setup">Connect an agent</a>
          <a class="button ghost" href="${GITHUB_URL}">Read the docs</a>
        </div>
      </div>`;

  return page(
    "Artifact Use admin",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav>${superAdmin ? `<a href="/admin/super">Super Admin</a>` : ""}<a href="#agent-setup">Connect an agent</a><a href="/logout">Sign out</a></nav>
    </header>
    <main class="admin">
      <section class="headline">
        <div>
          <p class="eyebrow">Publisher admin</p>
          <h1>Artifacts</h1>
          <p class="muted">${escapeHtml(session.email || session.name || session.sub)}</p>
        </div>
        ${metricsHtml}
      </section>
      ${artifactsHtml}
      ${agentSetupSection(env, tokens)}
      ${teamSection(session, team)}
      ${
        recent.length
          ? `<section class="activity">
              <p class="eyebrow">Recent activity</p>
              <h2>Latest views</h2>
              <ul class="activity-feed">${recent.map(recentViewItem).join("")}</ul>
            </section>`
          : ""
      }
    </main>`,
  );
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

function agentSetupSection(env: Env, tokens: AgentTokenRow[]): string {
  const base = siteBaseUrl(env);
  return `<section class="setup" id="agent-setup">
    <div>
      <p class="eyebrow">Agent setup</p>
      <h2>Connect an agent</h2>
      <p class="muted">Generate a prompt with a scoped publish token baked in and paste it to any agent — it handles the rest. OAuth-capable MCP clients can skip tokens: give them the MCP URL and sign in when prompted.</p>
      <p class="muted">Agent asked you to approve a code? <a href="/connect"><strong>Approve it here →</strong></a></p>
    </div>
    <div class="setup-grid">
      <form method="post" action="/admin/agent-prompt" class="token-form">
        <div>
          <label for="ap-label">Agent label</label>
          <input id="ap-label" name="label" placeholder="codex on my-laptop">
        </div>
        <div>
          <label for="ap-days">Expires in days</label>
          <input id="ap-days" name="expires_days" inputmode="numeric" placeholder="30">
        </div>
        <button type="submit">Generate agent prompt</button>
      </form>
      ${tokenListHtml(tokens)}
      <details class="manual">
        <summary>Manual setup — MCP URL and configs</summary>
        <div class="setup-grid">
          <div>
            <label for="mcp-url">MCP URL</label>
            <div class="copywrap"><button class="copy-lite" type="button" data-copy="mcp-url">Copy</button><input id="mcp-url" readonly value="${escapeHtml(base)}/mcp"></div>
          </div>
          <div>
            <label for="mcp-json">OAuth MCP config (Claude Code, MCP clients)</label>
            <div class="copywrap"><button class="copy-lite" type="button" data-copy="mcp-json">Copy</button><textarea id="mcp-json" readonly rows="8">${escapeHtml(mcpConfig(env))}</textarea></div>
          </div>
          <div>
            <label for="mcp-toml">Codex bearer config (~/.codex/config.toml)</label>
            <div class="copywrap"><button class="copy-lite" type="button" data-copy="mcp-toml">Copy</button><textarea id="mcp-toml" readonly rows="4">${escapeHtml(codexBearerConfig(env))}</textarea></div>
          </div>
          <p class="mini">Bearer tokens live in <code>ARTIFACT_USE_TOKEN</code> — never in config files, source, or published HTML.</p>
        </div>
      </details>
    </div>
  </section>`;
}

function tokenListHtml(tokens: AgentTokenRow[]): string {
  if (!tokens.length)
    return `<p class="mini">No active agent tokens yet. Generate a prompt above, or approve an agent's connect code at <a href="/connect">/connect</a>.</p>`;
  return `<ul class="token-list">${tokens
    .map(
      (token) => `<li>
      <span><strong>${escapeHtml(token.label || "Agent token")}</strong><small>${escapeHtml(token.source)} · created ${dateLabel(token.created_at)} · expires ${dateLabel(token.expires_at)}</small></span>
      <form method="post" action="/admin/agent-token/revoke">
        <input type="hidden" name="id" value="${escapeHtml(token.id)}">
        <button class="button small danger" type="submit">Revoke</button>
      </form>
    </li>`,
    )
    .join("")}</ul>`;
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

function teamSection(session: PublisherSession, team: WorkosTeam): string {
  const canManageTeam = isTeamAdmin(session);
  const canEditTeam =
    canManageTeam && isWorkosOrgId(session.orgId) && !team.error;
  const pending = team.invitations.filter(
    (invite) => invite.state === "pending" && !invite.revoked_at,
  );
  return `<section class="team-panel" id="team">
    <div>
      <p class="eyebrow">Team</p>
      <h2>Publisher access</h2>
      <p class="muted">Teammates you invite see the same artifacts, stats, and feedback as you.</p>
      <p class="mini">Workspace ID <code>${escapeHtml(session.orgId)}</code></p>
    </div>
    <div class="team-body">
      ${
        canEditTeam
          ? `<form method="post" action="/admin/team/invite" class="team-invite">
              <label>Email
                <input name="email" type="email" placeholder="teammate@example.com" required>
              </label>
              <label>Role
                <select name="role_slug">
                  ${TEAM_ROLE_OPTIONS.map((role) => `<option value="${role}">${role}</option>`).join("")}
                </select>
              </label>
              <label>Expires
                <input name="expires_days" inputmode="numeric" placeholder="14">
              </label>
              <button type="submit">Invite user</button>
            </form>`
          : canManageTeam
            ? ""
            : `<div class="empty small-empty"><strong>Invite access is admin-only.</strong><span>Ask an organization admin to invite or remove team members.</span></div>`
      }
      ${
        team.error
          ? `<div class="empty small-empty error-box">${escapeHtml(team.error)}</div>`
          : `<div class="team-grid">
        <section>
          <h3>Members</h3>
          ${
            team.members.length
              ? `<ul class="detail-list">${team.members.map(memberItem).join("")}</ul>`
              : `<div class="empty small-empty">No WorkOS members found.</div>`
          }
        </section>
        <section>
          <h3>Pending invites</h3>
          ${
            pending.length
              ? `<ul class="detail-list invite-list">${pending.map((invite) => invitationItem(invite, canEditTeam)).join("")}</ul>`
              : `<div class="empty small-empty">No pending invitations.</div>`
          }
        </section>
      </div>`
      }
    </div>
  </section>`;
}

function memberItem(member: WorkosMembership): string {
  const user = member.user || {};
  const name =
    user.name ||
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.email ||
    member.user_id;
  return `<li>
    <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(user.email || member.user_id)} · ${escapeHtml(member.status)}</small></span>
    <span class="pill">${escapeHtml(roleLabel(member))}</span>
  </li>`;
}

function invitationItem(
  invite: WorkosInvitation,
  canManageTeam: boolean,
): string {
  return `<li>
    <span><strong>${escapeHtml(invite.email)}</strong><small>${escapeHtml(invite.role_slug || "member")} · expires ${escapeHtml(dateLabelFromIso(invite.expires_at))}</small></span>
    ${
      canManageTeam
        ? `<form method="post" action="/admin/team/invite/revoke">
            <input type="hidden" name="id" value="${escapeHtml(invite.id)}">
            <button class="button small ghost danger" type="submit">Revoke</button>
          </form>`
        : `<time>${escapeHtml(invite.state)}</time>`
    }
  </li>`;
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
  const [shareRows, commentRows, recentRows, dailyRows] = await Promise.all([
    env.DB.prepare(
      `SELECT sl.*, a.id AS artifact_id, COUNT(v.id) AS view_count
       FROM share_links sl
       JOIN artifacts a ON a.id = sl.artifact_id
       LEFT JOIN views v ON v.share_link_id = sl.id
       WHERE a.org_id = ?
       GROUP BY sl.id
       ORDER BY sl.created_at DESC`,
    )
      .bind(orgId)
      .all<AdminShareLink>(),
    env.DB.prepare(
      `SELECT c.*
       FROM comments c
       JOIN artifacts a ON a.id = c.artifact_id
       WHERE a.org_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT 300`,
    )
      .bind(orgId)
      .all<AdminComment>(),
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
    shares: groupBy(shareRows.results || [], "artifact_id"),
    comments: groupBy(commentRows.results || [], "artifact_id"),
    recent: groupBy(recentRows.results || [], "artifact_id"),
    daily: groupBy(dailyRows.results || [], "artifact_id"),
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

async function renderSuperAdmin(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  if (!isSuperAdmin(session, env))
    return error(403, "forbidden", "super admin access is not configured");
  const url = new URL(request.url);
  const openId = url.searchParams.get("open") || "";
  const artifacts = await artifactStatsRows(env, {
    orderBy: "a.updated_at DESC",
    limit: 500,
  });
  const orgs = new Set(artifacts.map((artifact) => artifact.org_id));
  const totalViews = artifacts.reduce(
    (sum, artifact) => sum + Number(artifact.total_views || 0),
    0,
  );
  return page(
    "Super Admin",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav><a href="/admin">Admin</a><a href="/admin/super">Super Admin</a><a href="/logout">Sign out</a></nav>
    </header>
    <main class="admin">
      <section class="headline">
        <div>
          <p class="eyebrow">Super admin</p>
          <h1>All artifacts</h1>
          <p class="muted">${escapeHtml(session.email || session.sub)} · configured by ARTIFACT_USE_SUPER_ADMIN_USER_IDS</p>
        </div>
        <div class="metrics">
          <div><strong>${artifacts.length}</strong><span>Artifacts</span></div>
          <div><strong>${orgs.size}</strong><span>Orgs</span></div>
          <div><strong>${totalViews}</strong><span>Views</span></div>
          <div><strong>${artifacts.filter((artifact) => artifact.gate_level !== "public").length}</strong><span>Gated</span></div>
          <div><strong>${artifacts.reduce((sum, artifact) => sum + Number(artifact.comment_count || 0), 0)}</strong><span>Feedback</span></div>
        </div>
      </section>
      <section class="table">
        <div class="table-head super-head"><span>Artifact</span><span>Owner</span><span>Public URL</span><span>Stats</span><span>Move</span></div>
        ${
          artifacts.length
            ? artifacts
                .map((artifact) =>
                  superArtifactRow(env, artifact, openId === artifact.id),
                )
                .join("")
            : `<div class="empty"><strong>No artifacts found.</strong></div>`
        }
      </section>
    </main>`,
  );
}

function superArtifactRow(
  env: Env,
  artifact: ArtifactRow,
  open: boolean,
): string {
  const url = publicArtifactUrl(env, artifact.url_key);
  return `<article class="artifact-card" id="artifact-${escapeHtml(artifact.id)}">
    <div class="artifact-row super-row">
      <div class="artifact-title">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.id)} · ${escapeHtml(artifact.slug)}</span>
      </div>
      <div class="path-block">
        <code>${escapeHtml(artifact.org_id)}</code>
        <small>created_by ${escapeHtml(artifact.created_by)}</small>
      </div>
      <div class="path-block">
        <code>${escapeHtml(artifact.url_key)}</code>
        <small>${escapeHtml(url)}</small>
      </div>
      <div class="views">
        <strong>${formatNumber(artifact.total_views)}</strong>
        <span>${formatNumber(artifact.share_links)} links · ${formatNumber(artifact.comment_count)} feedback</span>
      </div>
      <div class="row-actions">
        <a class="button small ghost" href="${escapeHtml(url)}">Open</a>
      </div>
    </div>
    <details class="artifact-detail"${open ? " open" : ""}>
      <summary>Move ownership</summary>
      <form method="post" action="/admin/super/transfer" class="super-transfer">
        <input type="hidden" name="artifact_id" value="${escapeHtml(artifact.id)}">
        <label>Target WorkOS org
          <input name="target_org_id" placeholder="org_..." required>
        </label>
        <label>Target WorkOS user
          <input name="target_user_id" placeholder="user_..." required>
        </label>
        <button type="submit">Move artifact</button>
      </form>
      <p class="mini">Moving updates artifacts, versions, share links, and created_by to the target user. The public URL key stays ${escapeHtml(artifact.url_key)}.</p>
    </details>
  </article>`;
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

function codexBearerConfig(env: Env): string {
  return [
    "[mcp_servers.artifact-use]",
    `url = "${env.SITE_BASE_URL}/mcp"`,
    'bearer_token_env_var = "ARTIFACT_USE_TOKEN"',
  ].join("\n");
}

function creatorTokenShell(env: Env, token: string): string {
  return [
    `export ARTIFACT_USE_API_BASE=${env.SITE_BASE_URL}`,
    `export ARTIFACT_USE_TOKEN='${token}'`,
    "",
    "# Then start a fresh Codex process or open a new Codex thread.",
  ].join("\n");
}

function artifactRow(
  env: Env,
  artifact: ArtifactRow,
  detail: {
    shares: AdminShareLink[];
    comments: AdminComment[];
    recent: AdminRecentView[];
    daily: AdminDailyView[];
  },
  open: boolean,
): string {
  const url = publicArtifactUrl(env, artifact.url_key);
  const path = publicArtifactPath(env, artifact.url_key);
  const comments = detail.comments.filter(
    (comment) => !comment.parent_comment_id,
  );
  return `<article class="artifact-card" id="artifact-${escapeHtml(artifact.id)}">
    <div class="artifact-row">
      <div class="artifact-title">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.url_key)}</span>
      </div>
      <div class="path-block">
        <code>${escapeHtml(path)}</code>
        <small>${escapeHtml(url)}</small>
      </div>
      <form method="post" action="/admin/artifact/access" class="access">
        <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
        <select name="gate_level">
          ${["public", "email", "verified_email", "allowlist"].map((level) => `<option value="${level}"${artifact.gate_level === level ? " selected" : ""}>${level}</option>`).join("")}
        </select>
        <button type="submit">Update</button>
      </form>
      <div class="views">
        <strong>${formatNumber(artifact.total_views)}</strong>
        <span>${formatNumber(artifact.unique_viewers)} unique · ${formatNumber(artifact.comment_count)} feedback</span>
      </div>
      <div class="row-actions">
        <a class="button small ghost" href="${escapeHtml(url)}">Open</a>
      </div>
    </div>
    <details class="artifact-detail"${open ? " open" : ""}>
      <summary>Stats, links, feedback</summary>
      <div class="detail-grid">
        <section>
          <h3>Views · last 30 days</h3>
          ${barsHtml(detail.daily)}
          <p class="mini">${formatNumber(artifact.total_views)} total · ${formatNumber(artifact.unique_viewers)} unique · last ${ago(artifact.last_view_ts)}</p>
          <h3>Recent viewers</h3>
          ${detail.recent.length ? `<ul class="detail-list">${detail.recent.slice(0, 8).map(recentViewItem).join("")}</ul>` : `<div class="empty small-empty">No views yet.</div>`}
        </section>
        <section>
          <h3>Share links</h3>
          ${shareLinksHtml(env, artifact, detail.shares)}
          ${shareLinkForm(artifact)}
          <h3>Feedback</h3>
          ${comments.length ? `<ul class="detail-list">${comments.slice(0, 8).map(commentItem).join("")}</ul>` : `<div class="empty small-empty">No feedback yet.</div>`}
        </section>
        <section>
          <h3>Artifact details</h3>
          <dl class="meta-list">
            <div><dt>Public prefix</dt><dd><code>${escapeHtml(artifactPathPrefix(env) || "/")}</code></dd></div>
            <div><dt>Access</dt><dd>${escapeHtml(artifact.gate_level)}</dd></div>
            <div><dt>Open feedback</dt><dd>${formatNumber(artifact.open_comments)}</dd></div>
            <div><dt>Share links</dt><dd>${formatNumber(artifact.share_links)}</dd></div>
            <div><dt>Files</dt><dd>${formatNumber(artifact.file_count || 0)}</dd></div>
            <div><dt>Size</dt><dd>${formatBytes(artifact.total_size || 0)}</dd></div>
            <div><dt>Published</dt><dd>${dateLabel(artifact.completed_at)}</dd></div>
          </dl>
          <h3>Allowlist</h3>
          ${allowlistForm(artifact)}
        </section>
      </div>
    </details>
  </article>`;
}

function barsHtml(daily: AdminDailyView[]): string {
  if (!daily.length)
    return `<div class="empty small-empty">No views in this window.</div>`;
  const max = Math.max(1, ...daily.map((row) => Number(row.n || 0)));
  return `<div class="bars">${daily
    .map((row) => {
      const height = Math.max(4, Math.round((Number(row.n || 0) / max) * 100));
      return `<span style="height:${height}%" title="${escapeHtml(row.day)} · ${formatNumber(row.n)} views"></span>`;
    })
    .join("")}</div>`;
}

function recentViewItem(view: AdminRecentView): string {
  return `<li>
    <span><strong>${escapeHtml(view.email)}</strong><small>${escapeHtml(view.title || view.url_key || view.slug)}</small></span>
    <time>${ago(view.ts)}</time>
  </li>`;
}

function shareLinksHtml(
  env: Env,
  artifact: ArtifactRow,
  links: AdminShareLink[],
): string {
  if (!links.length)
    return `<div class="empty small-empty">No share links.</div>`;
  return `<ul class="detail-list links-list">${links
    .slice(0, 8)
    .map((link) => {
      const label =
        link.recipient_label || link.recipient_email || "Unlabeled link";
      const state = link.revoked_at
        ? "revoked"
        : link.expires_at && link.expires_at < nowSec()
          ? "expired"
          : "active";
      const url = `${publicArtifactUrl(env, artifact.url_key)}?v=${link.id}`;
      return `<li>
        <span><strong>${escapeHtml(label)}</strong><small>${formatNumber(link.view_count)} views · ${escapeHtml(state)} · ${escapeHtml(url)}</small></span>
        ${
          link.revoked_at
            ? `<span class="pill">Revoked</span>`
            : `<form method="post" action="/admin/artifact/share-link/revoke">
                <input type="hidden" name="id" value="${escapeHtml(link.id)}">
                <button class="button small ghost danger" type="submit">Revoke</button>
              </form>`
        }
      </li>`;
    })
    .join("")}</ul>`;
}

function shareLinkForm(artifact: ArtifactRow): string {
  return `<form method="post" action="/admin/artifact/share-link" class="share-create">
    <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
    <input name="recipient_email" type="email" placeholder="email">
    <input name="recipient_label" placeholder="label">
    <input name="expires_days" inputmode="numeric" placeholder="days">
    <button type="submit">Create link</button>
  </form>`;
}

function commentItem(comment: AdminComment): string {
  return `<li>
    <span><strong>${escapeHtml(comment.email)}</strong><small>${escapeHtml(comment.body)}</small></span>
    <time>${comment.resolved_at ? "resolved" : ago(comment.created_at)}</time>
  </li>`;
}

function allowlistForm(artifact: ArtifactRow): string {
  return `<form method="post" action="/admin/artifact/access" class="allowlist-form">
    <input type="hidden" name="artifact_key" value="${escapeHtml(artifact.url_key)}">
    <input type="hidden" name="gate_level" value="allowlist">
    <textarea name="allowlist_lines" rows="5" placeholder="acme.com&#10;jane@acme.com">${escapeHtml(allowlistLines(artifact.allowlist_json))}</textarea>
    <button type="submit">Save allowlist</button>
  </form>`;
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

function formatNumber(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  let seconds = nowSec() - Number(ts);
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function dateLabel(ts: number | null | undefined): string {
  if (!ts) return "not published";
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
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

async function createAgentPrompt(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const label =
    String(form.get("label") || "")
      .trim()
      .slice(0, 80) || null;
  const days = Number(form.get("expires_days") || 30);
  const minted = await mintCreatorToken(env, {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    label,
    source: "admin",
    expiresDays: Number.isFinite(days) ? days : 30,
  });
  const prompt = agentSetupPrompt(env, minted.token, minted.expiresAt);
  return page(
    "Agent connect prompt",
    `<header class="top">
      <a class="brand" href="/">Artifact Use</a>
      <nav><a href="/admin">Back to admin</a><a href="/logout">Sign out</a></nav>
    </header>
    <main class="admin">
      <section class="headline">
        <div>
          <p class="eyebrow">Agent setup</p>
          <h1>Paste this to your agent.</h1>
          <p class="muted">One message is the whole setup: token, endpoints, and instructions. It is shown once — generate another anytime, revoke this one from the admin.</p>
        </div>
      </section>
      <section class="setup prompt-block">
        <div>
          <p class="eyebrow">One-paste prompt</p>
          <h2>${escapeHtml(label || "Agent token")}</h2>
          <p class="muted">Valid until ${dateLabel(minted.expiresAt)}. Scope: publish, read, manage access, and stats — this workspace only.</p>
        </div>
        <div class="setup-grid">
          <div class="copywrap">
            <button class="copy-lite" type="button" data-copy="agent-prompt">Copy</button>
            <textarea id="agent-prompt" readonly rows="18">${escapeHtml(prompt)}</textarea>
          </div>
          <details class="manual">
            <summary>Just the pieces — token, env, Codex config</summary>
            <div class="setup-grid">
              <div>
                <label for="raw-token">Bearer token</label>
                <div class="copywrap"><button class="copy-lite" type="button" data-copy="raw-token">Copy</button><textarea id="raw-token" readonly rows="4">${escapeHtml(minted.token)}</textarea></div>
              </div>
              <div>
                <label for="raw-env">Shell environment</label>
                <div class="copywrap"><button class="copy-lite" type="button" data-copy="raw-env">Copy</button><textarea id="raw-env" readonly rows="4">${escapeHtml(creatorTokenShell(env, minted.token))}</textarea></div>
              </div>
              <div>
                <label for="raw-toml">Codex config (~/.codex/config.toml)</label>
                <div class="copywrap"><button class="copy-lite" type="button" data-copy="raw-toml">Copy</button><textarea id="raw-toml" readonly rows="4">${escapeHtml(codexBearerConfig(env))}</textarea></div>
              </div>
            </div>
          </details>
          <p class="mini">Keep the token in <code>ARTIFACT_USE_TOKEN</code> or a secret store — never in config files, source, or published HTML.</p>
        </div>
      </section>
    </main>`,
  );
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
  return redirect("/admin#agent-setup");
}

// Human side of the device-code style agent connect flow. GET shows what is
// being approved; POST mints the token onto the pending request.
export async function handleConnectPage(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const session = await getPublisherSession(request, env);
  if (!session) {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      cookie(NEXT_COOKIE, `/connect${url.search || ""}`, 15 * 60),
    );
    return redirect("/login", headers);
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const code = String(form.get("code") || "");
    const pending = await pendingConnectRequest(env, code);
    if (!pending)
      return connectPage({
        code,
        error:
          "No pending request matches this code — it may have expired (codes last 15 minutes) or already been used. Ask the agent to start again.",
      });
    const approved = await approveConnectRequest(env, pending, session);
    if (!approved.ok)
      return connectPage({
        code,
        error: "This code was just approved in another window.",
      });
    return connectPage({ approvedLabel: approved.label });
  }
  const code = url.searchParams.get("code") || "";
  const pending = code ? await pendingConnectRequest(env, code) : null;
  return connectPage({
    code,
    pendingLabel: pending?.agent_label || null,
    notFound: Boolean(code && normalizeUserCode(code) && !pending),
  });
}

function connectPage(state: {
  code?: string;
  pendingLabel?: string | null;
  notFound?: boolean;
  error?: string;
  approvedLabel?: string;
}): Response {
  const header = `<header class="top">
    <a class="brand" href="/">Artifact Use</a>
    <nav><a href="/admin">Admin</a><a href="/logout">Sign out</a></nav>
  </header>`;
  if (state.approvedLabel) {
    return page(
      "Agent approved",
      `${header}
      <main class="panel narrow">
        <p class="eyebrow">Agent connect</p>
        <h1>Approved.</h1>
        <p class="muted"><strong>${escapeHtml(state.approvedLabel)}</strong> receives its token the next time it polls — usually within seconds. It can publish to your workspace for 30 days.</p>
        <p class="muted">Change your mind? Revoke the token anytime under <a href="/admin#agent-setup"><strong>Agent setup</strong></a>.</p>
        <div class="actions"><a class="button" href="/admin">Back to admin</a></div>
      </main>`,
    );
  }
  return page(
    "Approve an agent",
    `${header}
    <main class="panel narrow">
      <p class="eyebrow">Agent connect</p>
      <h1>Approve an agent.</h1>
      <p class="muted">An agent asked to publish to your workspace and showed you a code. Approving mints it a 30-day publish token${state.pendingLabel ? ` for <strong>${escapeHtml(state.pendingLabel)}</strong>` : ""}, scoped to your artifacts.</p>
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
      ${state.notFound ? `<p class="error">No pending request matches this code — it may have expired (codes last 15 minutes) or already been used.</p>` : ""}
      <form method="post" action="/connect">
        <label for="code">Connect code</label>
        <input id="code" class="code-input" name="code" value="${escapeHtml(state.code || "")}" placeholder="ABCD-2345" autocomplete="one-time-code" required>
        <div class="actions"><button type="submit">Approve agent</button><a class="button ghost" href="/admin">Cancel</a></div>
      </form>
      <p class="mini">Only approve codes from an agent session you or a teammate started. Approval gives that agent publish access to this workspace.</p>
    </main>`,
  );
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
  return redirect("/admin#team");
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
  return redirect("/admin#team");
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
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const session = await verifyPayload<PublisherSession>(raw, env);
  // The typ check keeps viewer/upload tokens (same secret, same format) from
  // ever verifying as a publisher session.
  if (!session || session.typ !== "publisher" || session.exp < nowSec())
    return null;
  return session;
}

function publicSession(session: PublisherSession): Record<string, unknown> {
  return {
    sub: session.sub,
    org_id: session.orgId,
    email: session.email,
    name: session.name,
    role: session.role || null,
    roles: session.roles || [],
    permissions: session.permissions || [],
    exp: session.exp,
  };
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
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
const COPY_SCRIPT = `<script>addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=document.getElementById(b.getAttribute("data-copy"));if(!t)return;var v="value"in t&&t.value?t.value:t.textContent||"";navigator.clipboard.writeText(v).then(function(){var o=b.textContent;b.textContent="Copied";b.classList.add("copied");setTimeout(function(){b.textContent=o;b.classList.remove("copied")},1400)})});</script>`;

function page(
  title: string,
  body: string,
  opts: { description?: string; robots?: "index" | "noindex" } = {},
): Response {
  const description = opts.description
    ? `<meta name="description" content="${escapeHtml(opts.description)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(opts.description)}">`
    : "";
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
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
.brand{font:700 17px var(--serif);display:inline-flex;align-items:center;gap:8px}
.brand::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--lume);box-shadow:0 0 0 1.5px var(--accent)}
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
.hero{display:grid;grid-template-columns:minmax(0,1.04fr) minmax(0,.96fr);gap:clamp(28px,4vw,52px);align-items:center;padding:clamp(40px,7vh,76px) 0 clamp(40px,6vh,64px)}
.hero h1{font-size:clamp(34px,4.4vw,54px);line-height:1.06;margin:12px 0 0}
.lead{font-size:17.5px;line-height:1.65;color:var(--muted);max-width:54ch;margin:18px 0 0}
.actions{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}
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
.feat{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:var(--line);border:1px solid var(--line);margin:44px 0}
.feat div{background:var(--panel);padding:18px 20px}
.feat strong{display:block;font-size:15px;margin-bottom:5px}
.feat strong::before{content:"-> ";font-family:var(--mono);color:var(--accent)}
.feat span{font-size:13.5px;line-height:1.55;color:var(--muted)}
.agents{background:var(--dark);color:#e6efe8;border-radius:12px;padding:clamp(24px,4vw,40px);display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:clamp(22px,3.5vw,40px)}
.agents .eyebrow{color:var(--lume)}
.agents h2{font-size:clamp(24px,2.6vw,30px);margin:8px 0 12px;color:#fff}
.agents p{color:#9db3a9;font-size:15px;line-height:1.65;margin:0 0 10px}
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
footer.site{border-top:1px solid var(--line);margin-top:56px;padding:26px 0 44px;display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13.5px}
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
.token-form label{margin:0 0 6px}
.token-list{list-style:none;margin:6px 0 0;padding:0}
.token-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--line-soft);padding:8px 2px;font-size:13.5px}
.token-list li small{display:block;color:var(--muted);margin-top:2px}
.token-list form{margin:0}
details.manual{border:1px solid var(--line);border-radius:8px;background:var(--panel)}
details.manual summary{cursor:pointer;padding:12px 14px;font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--accent)}
details.manual .setup-grid{padding:2px 14px 16px}
.table{margin-top:26px}
.table-head,.artifact-row{display:grid;grid-template-columns:minmax(180px,.8fr) minmax(280px,1.35fr) 210px 150px 88px;gap:14px;align-items:center}
.table-head{padding:0 12px 10px;color:var(--muted);font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em}
.artifact-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:10px}
.artifact-row{padding:12px}
.artifact-title strong,.artifact-title span,.path-block small,.views span{display:block}
.artifact-title span,.path-block small,.views span{color:var(--muted);font-size:12.5px;margin-top:3px;word-break:break-all}
.path-block code,.meta-list code{font:12px var(--mono);word-break:break-all}
.views strong{font-variant-numeric:tabular-nums}
.row-actions{display:flex;justify-content:flex-end}
.access{display:grid;grid-template-columns:1fr auto;gap:8px}
.artifact-detail{border-top:1px solid var(--line-soft);padding:0 12px 14px}
.artifact-detail summary{cursor:pointer;color:var(--accent);font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.08em;padding:12px 0}
.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(220px,.75fr);gap:22px}
.detail-grid h3{margin:14px 0 10px;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
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
.super-head,.super-row{grid-template-columns:minmax(190px,.9fr) minmax(220px,1fr) minmax(240px,1.1fr) 150px 88px}
.super-transfer{display:grid;grid-template-columns:minmax(190px,1fr) minmax(190px,1fr) auto;gap:10px;align-items:end}
.super-transfer label{margin:0 0 6px}
@media(max-width:940px){.hero{grid-template-columns:1fr;padding-top:34px}.steps,.feat{grid-template-columns:1fr}.steps section{border-right:0;border-bottom:1px solid var(--line)}.steps section:last-child{border-bottom:0}.agents{grid-template-columns:1fr}.headline{flex-direction:column;align-items:flex-start}.setup,.team-panel,.team-grid,.team-invite,.token-form,.super-transfer{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr}.table-head{display:none}.artifact-row,.super-head,.super-row{grid-template-columns:1fr}.row-actions{justify-content:flex-start}.access,.share-create{grid-template-columns:1fr}.onboard ol{grid-template-columns:1fr}.metrics div{flex:1 1 33%;border-bottom:1px solid var(--line)}}
</style></head><body>${body}${COPY_SCRIPT}</body></html>`,
    { headers },
  );
}
