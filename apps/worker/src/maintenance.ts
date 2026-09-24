// Scheduled housekeeping. Upload sessions that never completed (a client
// crashed mid-upload, or the package was rejected at the limit) used to sit in
// D1 and R2 forever: 30 drafts holding 357 MB, and artifacts whose only
// version was a dead draft, which listings showed but nobody could open.
import type { Artifact, ArtifactVersion, Env } from "./types";
import { deleteArtifact, purgeVersion } from "./db";
import { nowSec } from "./util";

// Comfortably above the six-hour ceiling of an upload session.
export const ABANDONED_AFTER_SEC = 24 * 60 * 60;
const BATCH = 200;

export interface SweepReport {
  drafts: number;
  files: number;
  artifacts: number;
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
