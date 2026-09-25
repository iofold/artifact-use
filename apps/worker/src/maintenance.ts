// Scheduled housekeeping. Upload sessions that never completed (a client
// crashed mid-upload, or the package was rejected at the limit) used to sit in
// D1 and R2 forever: 30 drafts holding 357 MB, and artifacts whose only
// version was a dead draft, which listings showed but nobody could open.
import type { Artifact, ArtifactVersion, Env } from "./types";
import { deleteArtifact, purgeVersion } from "./db";
import { sendTokenExpiryEmail } from "./mailer";
import { nowSec, sha256Hex, siteBaseUrl } from "./util";
import {
  attemptDelivery,
  type DeliveryOptions,
  type DeliveryRow,
} from "./webhooks";
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

// Files published through the HTML path before September 2026 were stored
// without a sha256, so version diffs cannot tell "changed" from "unchanged"
// for them (62 rows in production). Hash a bounded batch per sweep by
// reading the object back from R2.
export async function backfillFileHashes(
  env: Env,
  limit = 50,
): Promise<{ hashed: number; missing: number }> {
  const rows = await env.DB.prepare(
    `SELECT version_id, path, storage_key FROM artifact_files
     WHERE sha256 IS NULL ORDER BY uploaded_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ version_id: string; path: string; storage_key: string }>();
  let hashed = 0;
  let missing = 0;
  for (const row of rows.results || []) {
    const object = await env.BUCKET.get(row.storage_key);
    if (!object || !("arrayBuffer" in object)) {
      missing += 1;
      continue;
    }
    const sha = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
    await env.DB.prepare(
      "UPDATE artifact_files SET sha256 = ? WHERE version_id = ? AND path = ? AND sha256 IS NULL",
    )
      .bind(sha, row.version_id, row.path)
      .run();
    hashed += 1;
  }
  return { hashed, missing };
}

// Device-code connect requests nobody approved: mark them expired so they
// stop counting as pending in the admin page and in any report.
export async function expireStaleConnectRequests(
  env: Env,
  now = nowSec(),
): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE connect_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
  )
    .bind(now)
    .run();
  return Number(result.meta?.changes || 0);
}

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

export interface WebhookRetryReport {
  attempted: number;
  delivered: number;
  dropped: number;
}

// Webhook deliveries whose retry is due. The first attempt happens at write
// time (webhooks.ts); this sweep drives the 1m/5m/30m/2h/12h backoff from the
// six-hourly cron, so a receiver that was down catches up without polling.
export async function retryWebhookDeliveries(
  env: Env,
  now = nowSec(),
  opts: DeliveryOptions = {},
): Promise<WebhookRetryReport> {
  const due = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.event, d.payload_json, d.attempts,
       d.next_attempt_at, d.delivered_at, d.last_status, d.last_error, d.created_at,
       w.url, w.secret, w.revoked_at
     FROM webhook_deliveries d
     JOIN artifact_webhooks w ON w.id = d.webhook_id
     WHERE d.delivered_at IS NULL AND d.next_attempt_at IS NOT NULL
       AND d.next_attempt_at <= ?
     ORDER BY d.next_attempt_at LIMIT ?`,
  )
    .bind(now, BATCH)
    .all<
      DeliveryRow & { url: string; secret: string; revoked_at: number | null }
    >();
  const report: WebhookRetryReport = { attempted: 0, delivered: 0, dropped: 0 };
  for (const row of due.results || []) {
    if (row.revoked_at) {
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE id = ?",
      )
        .bind(row.id)
        .run();
      report.dropped += 1;
      continue;
    }
    report.attempted += 1;
    const result = await attemptDelivery(
      env,
      row,
      { id: row.webhook_id, url: row.url, secret: row.secret },
      { ...opts, now: () => now },
    );
    if (result.ok) report.delivered += 1;
    else if (result.next_attempt_at === null) report.dropped += 1;
  }
  return report;
}
