import type { Artifact, Env } from "./types";
import { error, htmlPage, nowSec, randomId, wantsHtml } from "./util";

type ModerationAction = "suspend" | "restore";

export function isArtifactUnavailable(artifact: Artifact): boolean {
  return artifact.status === "suspended" || Boolean(artifact.org_suspended);
}

export function artifactUnavailableResponse(request: Request): Response {
  if (!wantsHtml(request))
    return error(410, "artifact_unavailable", "artifact is unavailable");

  const page = htmlPage(
    "Artifact unavailable",
    `<h1>Artifact unavailable</h1>
<p class="muted">This artifact is not currently available. Contact the person who shared it if you believe this is a mistake.</p>`,
  );
  return new Response(page.body, { status: 410, headers: page.headers });
}

export function unavailableArtifactResponse(
  request: Request,
  artifact: Artifact,
): Response | null {
  return isArtifactUnavailable(artifact)
    ? artifactUnavailableResponse(request)
    : null;
}

export async function suspendedOrganizationResponse(
  env: Env,
  orgId: string,
): Promise<Response | null> {
  const suspension = await env.DB.prepare(
    "SELECT org_id FROM org_suspensions WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ org_id: string }>();
  return suspension
    ? error(410, "organization_suspended", "organization is suspended")
    : null;
}

export async function moderateArtifact(
  env: Env,
  input: {
    actorUserId: string;
    artifactId: string;
    action: ModerationAction;
    reason: string | null;
  },
): Promise<boolean> {
  const artifact = await env.DB.prepare(
    "SELECT id, org_id FROM artifacts WHERE id = ?",
  )
    .bind(input.artifactId)
    .first<{ id: string; org_id: string }>();
  if (!artifact) return false;

  const now = nowSec();
  const update =
    input.action === "suspend"
      ? env.DB.prepare(
          `UPDATE artifacts
             SET status = 'suspended', moderation_reason = ?, moderated_by = ?, moderated_at = ?
             WHERE id = ?`,
        ).bind(input.reason, input.actorUserId, now, artifact.id)
      : env.DB.prepare(
          `UPDATE artifacts
             SET status = 'active', moderation_reason = NULL, moderated_by = ?, moderated_at = ?
             WHERE id = ?`,
        ).bind(input.actorUserId, now, artifact.id);
  const event = env.DB.prepare(
    `INSERT INTO moderation_events
       (id, actor_user_id, scope, artifact_id, org_id, action, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId("mod"),
    input.actorUserId,
    "artifact",
    artifact.id,
    artifact.org_id,
    input.action,
    input.reason,
    now,
  );
  await env.DB.batch([update, event]);
  return true;
}

export async function moderateOrganization(
  env: Env,
  input: {
    actorUserId: string;
    orgId: string;
    action: ModerationAction;
    reason: string | null;
  },
): Promise<void> {
  const now = nowSec();
  const update =
    input.action === "suspend"
      ? env.DB.prepare(
          `INSERT INTO org_suspensions (org_id, reason, actor_user_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(org_id) DO UPDATE SET
               reason = excluded.reason,
               actor_user_id = excluded.actor_user_id,
               created_at = excluded.created_at`,
        ).bind(input.orgId, input.reason, input.actorUserId, now)
      : env.DB.prepare("DELETE FROM org_suspensions WHERE org_id = ?").bind(
          input.orgId,
        );
  const event = env.DB.prepare(
    `INSERT INTO moderation_events
       (id, actor_user_id, scope, artifact_id, org_id, action, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId("mod"),
    input.actorUserId,
    "org",
    null,
    input.orgId,
    input.action,
    input.reason,
    now,
  );
  await env.DB.batch([update, event]);
}
