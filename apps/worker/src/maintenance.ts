// Scheduled housekeeping. Upload sessions that never completed (a client
// crashed mid-upload, or the package was rejected at the limit) used to sit in
// D1 and R2 forever: 30 drafts holding 357 MB, and artifacts whose only
// version was a dead draft, which listings showed but nobody could open.
import type { Artifact, ArtifactVersion, Env } from "./types";
import { deleteArtifact, purgeVersion } from "./db";
import { sendTokenExpiryEmail } from "./mailer";
import { nowSec, siteBaseUrl } from "./util";
import { workosApiMaybe } from "./workos";

// Comfortably above the six-hour ceiling of an upload session.
export const ABANDONED_AFTER_SEC = 24 * 60 * 60;
const BATCH = 200;

export interface SweepReport {
  drafts: number;
  files: number;
  artifacts: number;
}

export const TOKEN_EXPIRY_WARNING_SEC = 7 * 24 * 60 * 60;

// Warn each token's owner once, a week before expiry. Expiry used to be
// silent: the agent just started getting 401s one morning.
export async function notifyExpiringTokens(
  env: Env,
  now = nowSec(),
): Promise<{ notified: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, label, expires_at FROM creator_tokens
     WHERE revoked_at IS NULL AND expiry_notified_at IS NULL
       AND expires_at > ? AND expires_at <= ?
     ORDER BY expires_at LIMIT ?`,
  )
    .bind(now, now + TOKEN_EXPIRY_WARNING_SEC, BATCH)
    .all<{
      id: string;
      user_id: string;
      label: string | null;
      expires_at: number;
    }>();
  let notified = 0;
  let skipped = 0;
  const renewUrl = `${siteBaseUrl(env)}/admin/connect`;
  for (const row of rows.results || []) {
    let email: string | null = null;
    try {
      const user = await workosApiMaybe(
        env,
        `/user_management/users/${encodeURIComponent(row.user_id)}`,
      );
      email = typeof user?.email === "string" ? user.email : null;
    } catch {
      email = null;
    }
    if (email) {
      try {
        await sendTokenExpiryEmail(
          env,
          email,
          { label: row.label, expiresAt: Number(row.expires_at) },
          renewUrl,
        );
        notified += 1;
      } catch {
        skipped += 1;
        continue;
      }
    } else {
      skipped += 1;
    }
    // Mark even unreachable owners so the sweep does not retry forever.
    await env.DB.prepare(
      "UPDATE creator_tokens SET expiry_notified_at = ? WHERE id = ?",
    )
      .bind(now, row.id)
      .run();
  }
  return { notified, skipped };
}

export async function sweepAbandonedUploads(
  env: Env,
  now = nowSec(),
): Promise<SweepReport> {
  const cutoff = now - ABANDONED_AFTER_SEC;
  const drafts = await env.DB.prepare(
    `SELECT * FROM artifact_versions
     WHERE status IN ('draft', 'finalizing') AND created_at < ?
     ORDER BY created_at LIMIT ?`,
  )
    .bind(cutoff, BATCH)
    .all<ArtifactVersion>();
  let files = 0;
  for (const version of drafts.results || [])
    files += await purgeVersion(env, version);

  // An artifact with no versions and nothing attached is a shell left by a
  // start call that never uploaded, or by the purge above. Age keeps a
  // session that is still between start and first PUT out of reach.
  const shells = await env.DB.prepare(
    `SELECT a.* FROM artifacts a
     WHERE a.current_version_id IS NULL AND a.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.artifact_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM views w WHERE w.artifact_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM share_links s WHERE s.artifact_id = a.id)
     LIMIT ?`,
  )
    .bind(cutoff, BATCH)
    .all<Artifact>();
  for (const artifact of shells.results || [])
    await deleteArtifact(env, artifact);

  return {
    drafts: (drafts.results || []).length,
    files,
    artifacts: (shells.results || []).length,
  };
}
