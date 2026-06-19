import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Creator,
  Env,
  GateLevel,
} from "./types";
import { artifactUrlKey, nowSec, randomId } from "./util";

export async function getArtifactByPath(
  env: Env,
  legacyPrefix: string,
  slug: string,
): Promise<Artifact | null> {
  return env.DB.prepare(
    "SELECT * FROM artifacts WHERE tenant_slug = ? AND slug = ?",
  )
    .bind(legacyPrefix, slug)
    .first<Artifact>();
}

export async function getArtifactByLegacyPath(
  env: Env,
  legacyPrefix: string,
  slug: string,
): Promise<Artifact | null> {
  return env.DB.prepare(
    `SELECT a.*
     FROM legacy_artifact_paths p
     JOIN artifacts a ON a.id = p.artifact_id
     WHERE p.legacy_tenant_slug = ? AND p.legacy_slug = ?`,
  )
    .bind(legacyPrefix, slug)
    .first<Artifact>();
}

export async function getArtifactByUrlKey(
  env: Env,
  urlKey: string,
): Promise<Artifact | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE url_key = ?")
    .bind(urlKey)
    .first<Artifact>();
}

export async function getArtifactById(
  env: Env,
  id: string,
): Promise<Artifact | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(id)
    .first<Artifact>();
}

export async function getArtifactForOrg(
  env: Env,
  orgId: string,
  slug: string,
): Promise<Artifact | null> {
  return env.DB.prepare("SELECT * FROM artifacts WHERE org_id = ? AND slug = ?")
    .bind(orgId, slug)
    .first<Artifact>();
}

export async function upsertArtifact(
  env: Env,
  creator: Creator,
  artifactSlug: string,
  title: string,
  gateLevel: GateLevel,
): Promise<Artifact> {
  await ensureOwnerCompatibilityRow(env, creator.orgId, creator.email);
  const existing = await getArtifactForOrg(env, creator.orgId, artifactSlug);
  const now = nowSec();
  if (existing) {
    await env.DB.prepare(
      "UPDATE artifacts SET title = ?, gate_level = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        title || existing.title,
        gateLevel || existing.gate_level,
        now,
        existing.id,
      )
      .run();
    return (await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
      .bind(existing.id)
      .first<Artifact>()) as Artifact;
  }
  const id = randomId("art");
  const urlKey = artifactUrlKey(artifactSlug, id);
  await env.DB.prepare(
    `INSERT INTO artifacts
      (id, org_id, tenant_slug, slug, url_key, title, gate_level, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      creator.orgId,
      urlKey,
      artifactSlug,
      urlKey,
      title || artifactSlug,
      gateLevel,
      creator.sub,
      now,
      now,
    )
    .run();
  return (await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(id)
    .first<Artifact>()) as Artifact;
}

export async function ensureOwnerCompatibilityRow(
  env: Env,
  orgId: string,
  ownerEmail: string | null,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT org_id FROM tenants WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ org_id: string }>();
  if (existing) return;
  const now = nowSec();
  const slug = await ownerCompatibilitySlug(env, orgId);
  await env.DB.prepare(
    "INSERT INTO tenants (org_id, slug, name, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(orgId, slug, null, ownerEmail, now, now)
    .run();
}

async function ownerCompatibilitySlug(
  env: Env,
  orgId: string,
): Promise<string> {
  const base = `owner-${shortHash(orgId)}`;
  for (let i = 0; i < 20; i += 1) {
    const slug = i ? `${base}-${i}` : base;
    const existing = await env.DB.prepare(
      "SELECT org_id FROM tenants WHERE slug = ? LIMIT 1",
    )
      .bind(slug)
      .first<{ org_id: string }>();
    if (!existing) return slug;
  }
  throw new Error("could not allocate owner compatibility row");
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

export async function createDraftVersion(
  env: Env,
  creator: Creator,
  artifact: Artifact,
  entrypoint: string,
): Promise<ArtifactVersion> {
  const id = randomId("ver");
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO artifact_versions
      (id, artifact_id, org_id, status, entrypoint, created_by, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
  )
    .bind(id, artifact.id, creator.orgId, entrypoint, creator.sub, now)
    .run();
  return (await getVersionForOrg(env, creator.orgId, id)) as ArtifactVersion;
}

export async function getVersionForOrg(
  env: Env,
  orgId: string,
  id: string,
): Promise<ArtifactVersion | null> {
  return env.DB.prepare(
    "SELECT * FROM artifact_versions WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<ArtifactVersion>();
}

export async function getVersion(
  env: Env,
  id: string,
): Promise<ArtifactVersion | null> {
  return env.DB.prepare("SELECT * FROM artifact_versions WHERE id = ?")
    .bind(id)
    .first<ArtifactVersion>();
}

export async function getFile(
  env: Env,
  versionId: string,
  path: string,
): Promise<ArtifactFile | null> {
  return env.DB.prepare(
    "SELECT * FROM artifact_files WHERE version_id = ? AND path = ?",
  )
    .bind(versionId, path)
    .first<ArtifactFile>();
}

export async function listFilesForVersion(
  env: Env,
  versionId: string,
): Promise<ArtifactFile[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM artifact_files WHERE version_id = ? ORDER BY path",
  )
    .bind(versionId)
    .all<ArtifactFile>();
  return res.results || [];
}

export async function upsertFile(
  env: Env,
  versionId: string,
  path: string,
  storageKey: string,
  contentType: string,
  size: number,
  sha256: string | null,
): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO artifact_files (version_id, path, storage_key, content_type, size, sha256, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id, path)
     DO UPDATE SET storage_key = excluded.storage_key, content_type = excluded.content_type,
       size = excluded.size, sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at`,
  )
    .bind(versionId, path, storageKey, contentType, size, sha256, now)
    .run();
}

export async function upsertFileIfDraft(
  env: Env,
  orgId: string,
  versionId: string,
  path: string,
  storageKey: string,
  contentType: string,
  size: number,
  sha256: string | null,
): Promise<boolean> {
  const now = nowSec();
  const result = await env.DB.prepare(
    `INSERT INTO artifact_files (version_id, path, storage_key, content_type, size, sha256, uploaded_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM artifact_versions WHERE id = ? AND org_id = ? AND status = 'draft')
     ON CONFLICT(version_id, path)
     DO UPDATE SET storage_key = excluded.storage_key, content_type = excluded.content_type,
       size = excluded.size, sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at
     WHERE EXISTS (SELECT 1 FROM artifact_versions WHERE id = ? AND org_id = ? AND status = 'draft')`,
  )
    .bind(
      versionId,
      path,
      storageKey,
      contentType,
      size,
      sha256,
      now,
      versionId,
      orgId,
      versionId,
      orgId,
    )
    .run();
  return result.meta.changes > 0;
}

export async function claimVersionForCompletion(
  env: Env,
  orgId: string,
  versionId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE artifact_versions SET status = 'finalizing' WHERE id = ? AND org_id = ? AND status = 'draft'",
  )
    .bind(versionId, orgId)
    .run();
  return result.meta.changes > 0;
}

export async function revertVersionToDraft(
  env: Env,
  orgId: string,
  versionId: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE artifact_versions SET status = 'draft' WHERE id = ? AND org_id = ? AND status = 'finalizing'",
  )
    .bind(versionId, orgId)
    .run();
}

export async function completeVersion(
  env: Env,
  version: ArtifactVersion,
  manifestJson: string,
  totalSize: number,
  fileCount: number,
): Promise<void> {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE artifact_versions SET status = 'complete', manifest_json = ?, total_size = ?, file_count = ?, completed_at = ? WHERE id = ?",
    ).bind(manifestJson, totalSize, fileCount, now, version.id),
    env.DB.prepare(
      "UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ?",
    ).bind(version.id, now, version.artifact_id),
  ]);
}

export async function listArtifactsForOrg(
  env: Env,
  orgId: string,
): Promise<Artifact[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE org_id = ? ORDER BY updated_at DESC",
  )
    .bind(orgId)
    .all<Artifact>();
  return res.results || [];
}

export async function updateArtifactAccess(
  env: Env,
  artifact: Artifact,
  title: string | null,
  gateLevel: GateLevel | null,
  allowlistJson: string | null | undefined,
): Promise<Artifact> {
  const now = nowSec();
  await env.DB.prepare(
    "UPDATE artifacts SET title = COALESCE(?, title), gate_level = COALESCE(?, gate_level), allowlist_json = COALESCE(?, allowlist_json), updated_at = ? WHERE id = ?",
  )
    .bind(
      title,
      gateLevel,
      allowlistJson === undefined ? null : allowlistJson,
      now,
      artifact.id,
    )
    .run();
  return (await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(artifact.id)
    .first<Artifact>()) as Artifact;
}

export async function createShareLink(
  env: Env,
  artifact: Artifact,
  creator: Creator,
  recipientEmail: string | null,
  recipientLabel: string | null,
  expiresAt: number | null,
): Promise<string> {
  const id = randomId("sh").slice(3, 19);
  await env.DB.prepare(
    "INSERT INTO share_links (id, artifact_id, recipient_email, recipient_label, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      artifact.id,
      recipientEmail,
      recipientLabel,
      expiresAt,
      creator.sub,
      nowSec(),
    )
    .run();
  return id;
}

export async function insertView(
  env: Env,
  artifact: Artifact,
  shareLinkId: string | null,
  email: string,
  verified: boolean,
  request: Request,
): Promise<number> {
  const ua = request.headers.get("User-Agent");
  const referrer = request.headers.get("Referer");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = ip
    ? await crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(ip))
        .then((d) =>
          [...new Uint8Array(d)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 32),
        )
    : null;
  const result = await env.DB.prepare(
    "INSERT INTO views (artifact_id, version_id, share_link_id, email, verified, ip_hash, ua, referrer, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      artifact.id,
      artifact.current_version_id,
      shareLinkId,
      email,
      verified ? 1 : 0,
      ipHash,
      ua,
      referrer,
      nowSec(),
    )
    .run();
  return Number(result.meta.last_row_id);
}
