import type { Env } from "./types";
import { asArray } from "./util";

export function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class WorkosApiError extends Error {
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

export async function workosApi(
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

export async function workosApiMaybe(
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

export type WorkosDirectoryUser = {
  id: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email_verified?: boolean;
  created_at?: string;
  updated_at?: string;
  last_sign_in_at?: string | null;
};

export type WorkosDirectoryOrganization = {
  id: string;
  name?: string;
  external_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type WorkosDirectoryMembership = {
  id: string;
  user_id: string;
  organization_id: string;
  status?: string;
  role?: { slug?: string };
  roles?: Array<{ slug?: string }>;
  created_at?: string;
  updated_at?: string;
};

export type WorkosDirectory = {
  users: WorkosDirectoryUser[];
  organizations: WorkosDirectoryOrganization[];
  memberships: WorkosDirectoryMembership[];
};

async function listWorkosPages<T extends Record<string, unknown>>(
  env: Env,
  pathname: string,
  filters: Record<string, string> = {},
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  do {
    const params = new URLSearchParams({ ...filters, limit: "100" });
    if (after) params.set("after", after);
    const page = await workosApi(env, {
      path: `${pathname}?${params.toString()}`,
    });
    rows.push(...(asArray(page.data) as T[]));
    const metadata =
      page.list_metadata && typeof page.list_metadata === "object"
        ? (page.list_metadata as Record<string, unknown>)
        : {};
    after = stringClaim(metadata.after);
  } while (after);
  return rows;
}

// Super Admin needs the directory itself as its source of truth. Listing
// organizations first and memberships per organization also preserves users
// who belong to more than one workspace; neither artifacts nor the current
// browser session can provide that complete relationship.
export async function listWorkosDirectory(env: Env): Promise<WorkosDirectory> {
  const [users, organizations] = await Promise.all([
    listWorkosPages<WorkosDirectoryUser>(env, "/user_management/users"),
    listWorkosPages<WorkosDirectoryOrganization>(env, "/organizations"),
  ]);
  const membershipGroups = await Promise.all(
    organizations.map((organization) =>
      listWorkosPages<WorkosDirectoryMembership>(
        env,
        "/user_management/organization_memberships",
        { organization_id: organization.id },
      ),
    ),
  );
  return {
    users,
    organizations,
    memberships: membershipGroups.flat(),
  };
}

// Get-or-create the per-user WorkOS organization (external_id
// "artifact-use:<userId>") and make the user an admin member. Shared by the
// browser /callback bootstrap and the bearer-token path so both onboarding
// routes land users in the same real organization.
export async function ensurePublisherOrganization(
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
