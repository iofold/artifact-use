import type { Env } from "./types";
import { nowSec, slugify } from "./util";
import {
  listUserMemberships,
  stringClaim,
  workosApiMaybe,
  type WorkosDirectoryMembership,
} from "./workos";

// Per-request workspace selection for multi-workspace credentials. The
// selected workspace rides on this header (MCP tools and clients set it from
// their `workspace` input) and is validated against the user's active WorkOS
// memberships through a short-TTL D1 snapshot, so a membership that ends
// revokes access to that workspace within POSITIVE_TTL_SEC without touching
// the credential's other workspaces.
export const WORKSPACE_HEADER = "X-Artifact-Use-Workspace";

const POSITIVE_TTL_SEC = 5 * 60;
// A miss only re-queries WorkOS if the snapshot is older than this, so a
// stream of bad workspace names cannot hammer the WorkOS API.
const NEGATIVE_TTL_SEC = 60;

export interface WorkspaceRow {
  org_id: string;
  org_name: string;
  org_slug: string;
  role: string;
}

export class WorkspaceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function workspaceRequiredError(): WorkspaceError {
  return new WorkspaceError(
    400,
    "workspace_required",
    `this credential publishes to multiple workspaces; pass a workspace (org id or slug) on every call — MCP tools accept a "workspace" argument, HTTP clients send the ${WORKSPACE_HEADER} header. List yours with artifact_manage {"action":"workspaces"} or GET /api/v1/workspaces`,
  );
}

export function workspaceForbiddenError(requested: string): WorkspaceError {
  return new WorkspaceError(
    403,
    "workspace_forbidden",
    `this credential cannot act in workspace "${requested}": not an active membership of its user, or not the workspace the token is scoped to`,
  );
}

// The cached membership list for a user, refreshed from WorkOS when stale.
// On a WorkOS outage a non-empty snapshot is served stale rather than failing
// every request; emptiness is trusted only when WorkOS confirmed it.
export async function listWorkspaces(
  env: Env,
  userId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<WorkspaceRow[]> {
  const now = nowSec();
  const refreshedAt = await syncTimestamp(env, userId);
  const fresh = now - refreshedAt < POSITIVE_TTL_SEC;
  if (fresh && !opts.forceRefresh) return cachedWorkspaces(env, userId);
  try {
    return await refreshWorkspaces(env, userId, now);
  } catch {
    const cached = await cachedWorkspaces(env, userId);
    if (cached.length) return cached;
    throw new WorkspaceError(
      502,
      "workspace_lookup_failed",
      "could not verify workspace memberships with WorkOS",
    );
  }
}

// Resolve a requested workspace (org id or slug) to an org id the user is an
// active member of. Throws workspace_forbidden when it does not resolve.
export async function resolveWorkspaceOrg(
  env: Env,
  userId: string,
  requested: string,
): Promise<string> {
  const wanted = requested.trim();
  if (!wanted) throw workspaceRequiredError();
  let rows = await listWorkspaces(env, userId);
  let match = matchWorkspace(rows, wanted);
  if (!match) {
    // The membership may have been granted since the snapshot; retry once
    // against WorkOS unless a recent refresh already came back without it.
    const refreshedAt = await syncTimestamp(env, userId);
    if (nowSec() - refreshedAt >= NEGATIVE_TTL_SEC) {
      rows = await listWorkspaces(env, userId, { forceRefresh: true });
      match = matchWorkspace(rows, wanted);
    }
  }
  if (!match) throw workspaceForbiddenError(wanted);
  return match.org_id;
}

function matchWorkspace(
  rows: WorkspaceRow[],
  wanted: string,
): WorkspaceRow | null {
  if (/^org_[A-Za-z0-9]+$/.test(wanted)) {
    return rows.find((row) => row.org_id === wanted) || null;
  }
  const slug = slugify(wanted, "");
  const matches = rows.filter(
    (row) =>
      row.org_slug === slug ||
      row.org_name.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length > 1)
    throw new WorkspaceError(
      400,
      "workspace_ambiguous",
      `workspace "${wanted}" matches more than one organization; pass the org id instead`,
    );
  return matches[0] || null;
}

// Reflect a rename into every user's cached snapshot immediately instead of
// waiting out the TTL. WorkOS remains the source of truth.
export async function applyWorkspaceRename(
  env: Env,
  orgId: string,
  name: string,
): Promise<{ org_name: string; org_slug: string }> {
  const orgSlug = slugify(name, "");
  await env.DB.prepare(
    "UPDATE workspace_memberships SET org_name = ?, org_slug = ? WHERE org_id = ?",
  )
    .bind(name, orgSlug, orgId)
    .run();
  return { org_name: name, org_slug: orgSlug };
}

async function cachedWorkspaces(
  env: Env,
  userId: string,
): Promise<WorkspaceRow[]> {
  const rows = await env.DB.prepare(
    `SELECT org_id, org_name, org_slug, role FROM workspace_memberships
     WHERE user_id = ? ORDER BY org_name`,
  )
    .bind(userId)
    .all<WorkspaceRow>();
  return rows.results || [];
}

async function syncTimestamp(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT refreshed_at FROM workspace_membership_sync WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ refreshed_at: number }>();
  return row?.refreshed_at || 0;
}

async function refreshWorkspaces(
  env: Env,
  userId: string,
  now: number,
): Promise<WorkspaceRow[]> {
  const memberships = await listUserMemberships(env, userId);
  const active = memberships.filter(
    (m: WorkosDirectoryMembership) =>
      (m.status || "active") === "active" && m.organization_id,
  );
  const rows: WorkspaceRow[] = await Promise.all(
    active.map(async (m: WorkosDirectoryMembership) => {
      const organization = await workosApiMaybe(
        env,
        `/organizations/${encodeURIComponent(m.organization_id)}`,
      );
      const name = stringClaim(organization?.name) || m.organization_id;
      return {
        org_id: m.organization_id,
        org_name: name,
        org_slug: slugify(name, ""),
        role: m.role?.slug || "",
      };
    }),
  );
  const statements = [
    env.DB.prepare("DELETE FROM workspace_memberships WHERE user_id = ?").bind(
      userId,
    ),
    ...rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO workspace_memberships
         (user_id, org_id, org_name, org_slug, role, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(userId, row.org_id, row.org_name, row.org_slug, row.role, now),
    ),
    env.DB.prepare(
      `INSERT INTO workspace_membership_sync (user_id, refreshed_at)
       VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET refreshed_at = excluded.refreshed_at`,
    ).bind(userId, now),
  ];
  await env.DB.batch(statements);
  return rows;
}
