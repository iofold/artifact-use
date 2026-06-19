import type {
  Artifact,
  Creator,
  Env,
  GateLevel,
  PublisherSession,
} from "./types";
import { readCookie } from "./auth";
import { createShareLink, ensureTenant, updateArtifactAccess } from "./db";
import {
  artifactPathPrefix,
  assertSlug,
  error,
  escapeHtml,
  GATE_LEVELS,
  isSlug,
  json,
  normalizeEmail,
  nowSec,
  publicArtifactPath,
  publicArtifactUrl,
  randomId,
} from "./util";

const SESSION_COOKIE = "au_pub";
const STATE_COOKIE = "au_state";
const INVITE_COOKIE = "au_invite";
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
  tenant_slug: string;
  slug: string;
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

export async function renderHome(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getPublisherSession(request, env);
  if (session) return renderAdmin(request, env, session);
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
          <p class="eyebrow">Review-ready artifact links</p>
          <h1>Turn agent output into polished links people can open and review.</h1>
          <p class="lead">Publish single-file HTML prototypes, PDFs, images, or complete multi-file folders with tenant paths, access controls, and comments for feedback.</p>
          <div class="actions">
            <a class="button" href="/signup">Sign up</a>
            <a class="button ghost" href="/login">Sign in</a>
          </div>
        </div>
        <div class="status" aria-label="Artifact Use features">
          <span></span>
          <strong>Single HTML or full folders</strong>
          <em>WorkOS SSO publisher sign-in, email access, magic-link or email OTP links, whitelist gates, and comments.</em>
          <small>${escapeHtml(publicArtifactUrl(env, "tenant", "artifact"))}</small>
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
  if (!session) return redirect("/login");
  if (path === "/admin" && request.method === "GET")
    return renderAdmin(request, env, session);
  if (path === "/admin/tenant" && request.method === "POST")
    return updateTenant(request, env, session);
  if (path === "/admin/artifact/access" && request.method === "POST")
    return updateAccess(request, env, session);
  if (path === "/admin/artifact/share-link" && request.method === "POST")
    return createAdminShareLink(request, env, session);
  if (path === "/admin/artifact/share-link/revoke" && request.method === "POST")
    return revokeAdminShareLink(request, env, session);
  if (path === "/admin/team/invite" && request.method === "POST")
    return createPublisherInvite(request, env, session);
  if (path === "/admin/team/invite/revoke" && request.method === "POST")
    return revokePublisherInvite(request, env, session);
  if (path === "/admin/me" && request.method === "GET")
    return json({ publisher: publicSession(session) });
  return error(404, "not_found", "publisher admin route not found");
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
    userId ? legacyBearerUserOrgId(userId) : "",
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
      await migratePublisherDataToOrg(env, fallbackOrgIds, workosOrg);
      if (!roles.length) roles.push("admin");
    }
  } else if (await isOwnedPublisherOrganization(env, authOrgId, userId)) {
    await migratePublisherDataToOrg(env, fallbackOrgIds, authOrgId);
  }
  const session: PublisherSession = {
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
    cookie(SESSION_COOKIE, await signSession(session, env), 7 * 86400),
  );
  headers.append("Set-Cookie", expireCookie(STATE_COOKIE));
  headers.append("Set-Cookie", expireCookie(INVITE_COOKIE));
  return redirect("/admin", headers);
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
  const res = await fetch(
    "https://api.workos.com/user_management/authenticate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WORKOS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(
      `WorkOS auth failed: ${res.status} ${String(parsed.error || parsed.code || text)}`,
    );
  }
  return parsed;
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
): Promise<void> {
  const unique = [...new Set(fromOrgIds.filter((id) => id && id !== toOrgId))];
  const now = nowSec();
  for (const fromOrgId of unique) {
    const sourceTenant = await env.DB.prepare(
      "SELECT org_id, slug, name, owner_email, created_at FROM tenants WHERE org_id = ?",
    )
      .bind(fromOrgId)
      .first<{
        org_id: string;
        slug: string;
        name: string | null;
        owner_email: string | null;
        created_at: number;
      }>();
    const targetTenant = await env.DB.prepare(
      "SELECT org_id, slug FROM tenants WHERE org_id = ?",
    )
      .bind(toOrgId)
      .first<{ org_id: string; slug: string }>();
    if (!sourceTenant && !targetTenant) continue;
    if (targetTenant || !sourceTenant) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE artifact_versions SET org_id = ? WHERE org_id = ?",
        ).bind(toOrgId, fromOrgId),
        env.DB.prepare("UPDATE artifacts SET org_id = ? WHERE org_id = ?").bind(
          toOrgId,
          fromOrgId,
        ),
        env.DB.prepare("DELETE FROM tenants WHERE org_id = ?").bind(fromOrgId),
      ]);
      continue;
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO tenants (org_id, slug, name, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        toOrgId,
        `__migrating_${randomId("tenant")}`,
        sourceTenant.name,
        sourceTenant.owner_email,
        sourceTenant.created_at || now,
        now,
      ),
      env.DB.prepare(
        "UPDATE artifact_versions SET org_id = ? WHERE org_id = ?",
      ).bind(toOrgId, fromOrgId),
      env.DB.prepare("UPDATE artifacts SET org_id = ? WHERE org_id = ?").bind(
        toOrgId,
        fromOrgId,
      ),
      env.DB.prepare("DELETE FROM tenants WHERE org_id = ?").bind(fromOrgId),
      env.DB.prepare(
        "UPDATE tenants SET slug = ?, name = ?, owner_email = ?, updated_at = ? WHERE org_id = ?",
      ).bind(
        sourceTenant.slug,
        sourceTenant.name,
        sourceTenant.owner_email,
        now,
        toOrgId,
      ),
    ]);
  }
}

async function renderAdmin(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const openId = new URL(request.url).searchParams.get("open") || "";
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE org_id = ?")
    .bind(session.orgId)
    .first<{ slug: string; name: string | null; owner_email: string | null }>();
  const rows = await env.DB.prepare(
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
     WHERE a.org_id = ?
     GROUP BY a.id
     ORDER BY total_views DESC, a.updated_at DESC`,
  )
    .bind(session.orgId)
    .all<ArtifactRow>();
  const artifacts = rows.results || [];
  const maps = await adminMaps(env, session.orgId);
  const totalViews = artifacts.reduce(
    (sum, row) => sum + Number(row.total_views || 0),
    0,
  );
  const totalComments = artifacts.reduce(
    (sum, row) => sum + Number(row.comment_count || 0),
    0,
  );
  const views7d = await viewsSince(env, session.orgId, nowSec() - 7 * 86400);
  const uniqueViewers = new Set<string>();
  const uniqueRows = await env.DB.prepare(
    `SELECT DISTINCT v.email
     FROM views v JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.org_id = ?`,
  )
    .bind(session.orgId)
    .all<{ email: string }>();
  for (const row of uniqueRows.results || []) uniqueViewers.add(row.email);
  const recent = Array.from(maps.recent.values())
    .flat()
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, 18);
  const team = await adminTeam(env, session);

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
          <div><strong>${views7d}</strong><span>Views · 7d</span></div>
          <div><strong>${totalComments}</strong><span>Feedback</span></div>
        </div>
      </section>
      <section class="route-panel">
        <div>
          <p class="eyebrow">Prefixes</p>
          <h2>Routes in use</h2>
          <p class="muted">New Artifact Use links stay under the public prefix so legacy direct artifact paths remain on the old host.</p>
        </div>
        <div class="prefix-grid">
          ${prefixItem("Site base", env.SITE_BASE_URL)}
          ${prefixItem("Public artifact prefix", artifactPathPrefix(env) || "/")}
          ${prefixItem("Artifact path pattern", `${artifactPathPrefix(env)}/{tenant}/{artifact}/`)}
          ${prefixItem("Current tenant prefix", `${artifactPathPrefix(env)}/${tenant?.slug || suggestedSlug(session.email || session.sub)}/`)}
          ${prefixItem("Reserved product paths", "/admin, /api/v1, /_au, /login, /signup, /invite, /callback, /logout, /llms.txt")}
        </div>
      </section>
      <section class="setup">
        <div>
          <p class="eyebrow">Agent setup</p>
          <h2>Connect your coding agent</h2>
          <p class="muted">Use the remote MCP URL below. OAuth-capable MCP clients will prompt you to sign in with WorkOS.</p>
        </div>
        <div class="setup-grid">
          <label>MCP URL
            <input readonly value="${escapeHtml(env.SITE_BASE_URL)}/mcp" onclick="this.select()">
          </label>
          <label>MCP config
            <textarea readonly rows="7" onclick="this.select()">${escapeHtml(mcpConfig(env))}</textarea>
          </label>
        </div>
      </section>
      ${teamSection(session, team)}
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
        <div class="table-head"><span>Artifact</span><span>Public path</span><span>Access</span><span>Stats</span><span></span></div>
        ${
          artifacts.length
            ? artifacts
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
                .join("")
            : `<div class="empty"><strong>No artifacts yet.</strong><span>Published artifacts from MCP or the CLI will appear here.</span></div>`
        }
      </section>
      <section class="activity">
        <div>
          <p class="eyebrow">Recent activity</p>
          <h2>Latest views</h2>
        </div>
        ${recent.length ? `<ul class="activity-feed">${recent.map(recentViewItem).join("")}</ul>` : `<div class="empty"><strong>No views yet.</strong><span>Viewer activity will appear here after gated artifacts are opened.</span></div>`}
      </section>
    </main>`,
  );
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
        "Team invitations are unavailable until this publisher session is upgraded to a WorkOS organization. Sign out and sign in again to upgrade.",
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
      <p class="muted">Publisher accounts use WorkOS organization membership. Everyone in this organization works from the same artifact list and tenant prefix.</p>
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
      `SELECT v.artifact_id, a.tenant_slug, a.slug, a.title, v.email, v.verified, v.ts, v.referrer
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
  const url = publicArtifactUrl(env, artifact.tenant_slug, artifact.slug);
  const path = publicArtifactPath(env, artifact.tenant_slug, artifact.slug);
  const comments = detail.comments.filter(
    (comment) => !comment.parent_comment_id,
  );
  return `<article class="artifact-card" id="artifact-${escapeHtml(artifact.id)}">
    <div class="artifact-row">
      <div class="artifact-title">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.tenant_slug)}/${escapeHtml(artifact.slug)}</span>
      </div>
      <div class="path-block">
        <code>${escapeHtml(path)}</code>
        <small>${escapeHtml(url)}</small>
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

function prefixItem(label: string, value: string): string {
  return `<div class="prefix-item"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`;
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
    <span><strong>${escapeHtml(view.email)}</strong><small>${escapeHtml(view.title || `${view.tenant_slug}/${view.slug}`)}</small></span>
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
      const url = `${publicArtifactUrl(env, artifact.tenant_slug, artifact.slug)}?v=${link.id}`;
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
    <input type="hidden" name="tenant" value="${escapeHtml(artifact.tenant_slug)}">
    <input type="hidden" name="artifact" value="${escapeHtml(artifact.slug)}">
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
    <input type="hidden" name="tenant" value="${escapeHtml(artifact.tenant_slug)}">
    <input type="hidden" name="artifact" value="${escapeHtml(artifact.slug)}">
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

async function updateTenant(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const slug = assertSlug("tenant", String(form.get("tenant") || ""));
  const creator = creatorFromSession(session);
  await ensureTenant(
    env,
    creator,
    slug,
    String(form.get("name") || "") || null,
  );
  return redirect("/admin");
}

async function updateAccess(
  request: Request,
  env: Env,
  session: PublisherSession,
): Promise<Response> {
  const form = await request.formData();
  const tenantSlug = assertSlug("tenant", String(form.get("tenant") || ""));
  const artifactSlug = assertSlug(
    "artifact",
    String(form.get("artifact") || ""),
  );
  const gateLevel = String(form.get("gate_level") || "") as GateLevel;
  if (!GATE_LEVELS.has(gateLevel))
    return error(400, "invalid_gate_level", "gate_level is not supported");
  const artifact = await publisherArtifact(
    env,
    session,
    tenantSlug,
    artifactSlug,
  );
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
  const tenantSlug = assertSlug("tenant", String(form.get("tenant") || ""));
  const artifactSlug = assertSlug(
    "artifact",
    String(form.get("artifact") || ""),
  );
  const artifact = await publisherArtifact(
    env,
    session,
    tenantSlug,
    artifactSlug,
  );
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

async function workosApiMaybe(
  env: Env,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await workosApi(env, { path });
  } catch (e) {
    if (e instanceof WorkosApiError && e.status === 404) return null;
    throw e;
  }
}

async function workosApi(
  env: Env,
  init: {
    path: string;
    method?: string;
    body?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!env.WORKOS_API_KEY) throw new Error("WorkOS API key is not configured");
  const headers = new Headers({
    Authorization: `Bearer ${env.WORKOS_API_KEY}`,
  });
  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  const requestInit: RequestInit = {
    method: init.method || "GET",
    headers,
  };
  if (body) requestInit.body = body;
  const res = await fetch(`https://api.workos.com${init.path}`, requestInit);
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw WorkosApiError.from(res.status, parsed, text);
  return parsed;
}

class WorkosApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }

  static from(
    status: number,
    parsed: Record<string, unknown>,
    fallback: string,
  ): WorkosApiError {
    const message =
      stringClaim(parsed.message) ||
      stringClaim(parsed.error_description) ||
      stringClaim(parsed.error) ||
      stringClaim(parsed.code) ||
      fallback ||
      "WorkOS request failed";
    return new WorkosApiError(status, `WorkOS ${status}: ${message}`);
  }
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

function extractStringArray(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return [];
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

function legacyBearerUserOrgId(userId: string): string {
  return `user_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function publisherArtifact(
  env: Env,
  session: PublisherSession,
  tenantSlug: string,
  artifactSlug: string,
): Promise<Artifact | null> {
  return env.DB.prepare(
    "SELECT * FROM artifacts WHERE tenant_slug = ? AND slug = ? AND org_id = ?",
  )
    .bind(tenantSlug, artifactSlug, session.orgId)
    .first<Artifact>();
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
    role: session.role || null,
    roles: session.roles || [],
    permissions: session.permissions || [],
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
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Aptos,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}a{color:inherit;text-decoration:none}.top{height:66px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,4vw,48px);background:var(--paper);position:sticky;top:0;z-index:5}.brand{font-weight:800}.top nav{display:flex;gap:10px;align-items:center}.top nav a{padding:9px 10px;border-radius:6px;color:var(--muted)}.top nav a:hover{background:var(--field);color:var(--ink)}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;padding:0 14px;font:700 14px inherit;cursor:pointer}.button.ghost{background:transparent;color:var(--accent)}.button.small{min-height:34px;padding:0 11px}.button.danger{border-color:#b84a3a;color:#b84a3a}.home,.admin{max-width:1180px;margin:0 auto;padding:clamp(26px,5vw,56px) clamp(18px,4vw,34px)}.hero{min-height:calc(100vh - 150px);display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:44px;align-items:center}.eyebrow{font-size:12px;font-weight:800;text-transform:uppercase;color:var(--accent);margin:0 0 14px}.hero h1,.headline h1{font-size:clamp(36px,6vw,74px);line-height:.96;margin:0;max-width:780px}.lead{font-size:20px;line-height:1.5;color:var(--muted);max-width:680px}.actions{display:flex;gap:12px;margin-top:26px}.status{border-left:3px solid var(--accent);padding:18px 0 18px 20px}.status span{display:block;width:10px;height:10px;border-radius:50%;background:var(--accent2);box-shadow:0 0 0 5px rgba(214,255,98,.28);margin-bottom:16px}.status strong,.status em,.status small{display:block}.status em{margin-top:8px;color:var(--muted);font-style:normal;line-height:1.5}.status small{margin-top:14px;color:var(--muted);word-break:break-all}.headline{display:flex;align-items:end;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line);padding-bottom:26px}.headline h1{font-size:clamp(32px,4vw,54px)}.muted{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(92px,1fr));border:1px solid var(--line);background:var(--panel);min-width:min(620px,100%)}.metrics div{padding:16px;border-right:1px solid var(--line)}.metrics div:last-child{border-right:0}.metrics strong{display:block;font-size:26px}.metrics span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.route-panel{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}.route-panel h2{margin:0 0 8px;font-size:24px}.prefix-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.prefix-item{border:1px solid var(--line);background:#fff;padding:11px;border-radius:6px;min-width:0}.prefix-item span{display:block;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;margin-bottom:6px}.prefix-item code,.path-block code,.meta-list code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;word-break:break-all}.setup{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}.setup h2{margin:0 0 8px;font-size:24px}.setup-grid{display:grid;gap:12px}label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;color:var(--muted);margin-bottom:8px}.toolbar{padding:24px 0;border-bottom:1px solid var(--line)}.inline{display:grid;grid-template-columns:minmax(160px,260px) minmax(160px,1fr) auto;gap:10px}input,select,textarea{width:100%;min-height:38px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:8px 10px;font:inherit;text-transform:none;color:var(--ink)}textarea{resize:vertical;font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;line-height:1.45}.table{margin-top:22px}.table-head,.artifact-row{display:grid;grid-template-columns:minmax(220px,1.1fr) minmax(220px,1fr) 210px 155px 96px;gap:14px;align-items:center}.table-head{padding:0 12px 10px;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase}.artifact-card{background:#fff;border:1px solid var(--line);margin-bottom:10px}.artifact-row{border:0;padding:12px;margin:0}.artifact-title strong,.artifact-title span,.path-block small,.views span{display:block}.artifact-title span,.path-block small,.views span{color:var(--muted);font-size:13px;margin-top:3px;word-break:break-all}.row-actions{display:flex;justify-content:flex-end}.access{display:grid;grid-template-columns:1fr auto;gap:8px}.artifact-detail{border-top:1px solid var(--line);padding:0 12px 14px}.artifact-detail summary{cursor:pointer;color:var(--accent);font-weight:800;padding:12px 0}.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(220px,.75fr);gap:22px}.detail-grid h3,.activity h2{margin:14px 0 10px;font-size:12px;text-transform:uppercase;color:var(--muted)}.bars{height:70px;display:flex;gap:3px;align-items:flex-end;border-bottom:1px solid var(--line)}.bars span{flex:1;min-height:4px;background:var(--accent);border-radius:3px 3px 0 0}.mini{font-size:12px;color:var(--muted);margin:7px 0 0}.detail-list,.activity-feed{list-style:none;margin:0;padding:0}.detail-list li,.activity-feed li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #edf1f0;padding:8px 0;font-size:13px}.detail-list li small,.activity-feed li small{display:block;color:var(--muted);margin-top:3px;word-break:break-word}.detail-list time,.activity-feed time{color:var(--muted);white-space:nowrap}.links-list form{margin:0}.share-create{display:grid;grid-template-columns:minmax(120px,1fr) minmax(90px,.8fr) 70px auto;gap:8px;margin-top:10px}.meta-list{display:grid;gap:7px;margin:0}.meta-list div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px}.meta-list dt{color:var(--muted);font-size:12px}.meta-list dd{margin:0;font-size:13px}.allowlist-form{display:grid;gap:8px}.activity{padding-top:24px}.empty{border:1px solid var(--line);background:#fff;padding:24px}.small-empty{padding:10px;font-size:13px}.empty strong,.empty span{display:block}.empty span{color:var(--muted);margin-top:6px}.pill{display:inline-flex;align-items:center;min-height:28px;border-radius:999px;background:var(--field);color:var(--muted);font-size:12px;padding:0 9px}.panel.narrow{max-width:520px;margin:14vh auto;padding:32px}.error{color:#a33434}@media(max-width:900px){.headline,.route-panel,.setup{align-items:start;grid-template-columns:1fr}.detail-grid,.prefix-grid{grid-template-columns:1fr}.table-head,.artifact-row{grid-template-columns:1fr}.table-head{display:none}.row-actions{justify-content:flex-start}.share-create{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));width:100%;min-width:0}.metrics div{border-right:0;border-bottom:1px solid var(--line)}.metrics div:last-child{border-bottom:0}}@media(max-width:760px){.hero{grid-template-columns:1fr;min-height:auto}.headline{align-items:start;flex-direction:column}.setup{grid-template-columns:1fr}.inline{grid-template-columns:1fr}.access{grid-template-columns:1fr}.actions{flex-wrap:wrap}}
@media(min-width:901px){.table-head,.artifact-row{grid-template-columns:minmax(180px,.8fr) minmax(280px,1.35fr) 210px 150px 88px}.share-create{grid-template-columns:minmax(120px,1fr) minmax(90px,1fr) 70px}.share-create button{grid-column:1/-1}}.share-create button{white-space:nowrap}
.team-panel{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}.team-panel h2{margin:0 0 8px;font-size:24px}.team-body{display:grid;gap:14px;align-content:start}.team-invite{display:grid;grid-template-columns:minmax(190px,1fr) 140px 110px auto;gap:10px;align-items:end}.team-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.team-grid h3{margin:10px 0;font-size:12px;text-transform:uppercase;color:var(--muted)}.error-box{color:#8f2f26;border-color:#e3b7af;background:#fff8f6}.invite-list form{margin:0}@media(max-width:900px){.team-panel,.team-grid,.team-invite{grid-template-columns:1fr}}
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
