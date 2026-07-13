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
