import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Creator,
  Env,
  GateLevel,
  ManifestFile,
  PublishManifest,
} from "./types";
import {
  CREATOR_TOKEN_PREFIX,
  authRequired,
  requirePermission,
  safeCreator,
  signUploadToken,
  verifyUploadToken,
} from "./auth";
import {
  claimVersionForCompletion,
  completeVersion,
  createDraftVersion,
  findArtifactForPublish,
  getFile,
  getVersion,
  getVersionForOrg,
  listFilesForVersion,
  purgeVersion,
  revertVersionToDraft,
  updateArtifactPreview,
  upsertArtifact,
  upsertFileIfDraft,
} from "./db";
import { publishLinks, versionUrl } from "./versions";
import { suspendedOrganizationResponse } from "./moderation";
import {
  extractArtifactDescription,
  normalizeArtifactDescription,
} from "./preview";
import {
  allowsSecrets,
  isTextLike,
  MAX_FINDINGS,
  MAX_SCAN_BYTES,
  MAX_SCAN_FILES,
  scanForSecrets,
  secretsDetectedMessage,
  type Finding,
} from "./scan";
import {
  assertSlug,
  bearerToken,
  error,
  GATE_LEVELS,
  isSlug,
  json,
  mimeFor,
  nowSec,
  publicArtifactUrl,
  randomId,
  readLimit,
  sha256Hex,
  validateAssetPath,
} from "./util";

interface StartBody {
  artifact: string;
  title?: string;
  description?: string;
  gate_level?: GateLevel;
  entrypoint?: string;
  ttl_seconds?: number;
  // Optional pre-flight declaration so an over-limit package is refused
  // before a single byte is uploaded (see declaredLimitsResponse).
  file_count?: number;
  package_bytes?: number;
  // Optimistic concurrency: the version the caller last published or read.
  // A republish is refused (409 version_conflict) when the artifact has
  // moved on, before anything is created (see baseVersionConflict).
  base_version_id?: string;
}

interface PublishActor {
  orgId: string;
  sub: string | null;
}

// Attached to every successful publish so the agent relays what "published"
// means before pasting the link somewhere.
export const UNLISTED_NOTE =
  "This URL is unlisted: search engines are told not to index it. Anyone who has the link and passes the gate can open it.";

export async function handlePublish(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  try {
    if (request.method === "POST" && path === "/api/v1/publish/start") {
      const creatorOrResponse = await safeCreator(request, env);
      if (creatorOrResponse instanceof Response) return creatorOrResponse;
      const creator = creatorOrResponse;
      requirePermission(creator, env, "artifacts:publish");
      const suspended = await suspendedOrganizationResponse(env, creator.orgId);
      if (suspended) return suspended;
      const body = (await request.json()) as StartBody;
      const overLimit = declaredLimitsResponse(env, body);
      if (overLimit) return overLimit;
      const conflict = await baseVersionConflict(env, creator, body);
      if (conflict) return conflict;
      return json(await createDraft(env, creator, body));
    }

    if (
      request.method === "POST" &&
      path === "/api/v1/publish/upload-session"
    ) {
      const creatorOrResponse = await safeCreator(request, env);
      if (creatorOrResponse instanceof Response) return creatorOrResponse;
      const creator = creatorOrResponse;
      requirePermission(creator, env, "artifacts:publish");
      const suspended = await suspendedOrganizationResponse(env, creator.orgId);
      if (suspended) return suspended;
      const body = (await request.json()) as StartBody;
      const overLimit = declaredLimitsResponse(env, body);
      if (overLimit) return overLimit;
      const ttl = uploadSessionTtl(body.ttl_seconds);
      if (ttl instanceof Response) return ttl;
      const conflict = await baseVersionConflict(env, creator, body);
      if (conflict) return conflict;
      const draft = await createDraft(env, creator, body);
      const expiresAt = nowSec() + ttl;
      const uploadToken = await signUploadToken(
        {
          typ: "artifact_upload",
          org_id: creator.orgId,
          version_id: draft.version.id,
          created_by: creator.sub,
          exp: expiresAt,
        },
        env,
      );
      return json({
        ...draft,
        upload_token: uploadToken,
        token_type: "Bearer",
        expires_at: expiresAt,
        ttl_seconds: ttl,
        complete_url: `${env.SITE_BASE_URL}/api/v1/publish/${draft.version.id}/complete`,
        instructions: {
          upload:
            "PUT each file to upload_base + URL-encoded relative path with Authorization: Bearer <upload_token>, Content-Length, Content-Type, and X-Artifact-Sha256.",
          complete:
            "POST the manifest JSON to complete_url with Authorization: Bearer <upload_token> after all files are uploaded.",
        },
      });
    }

    const uploadMatch = path.match(
      /^\/api\/v1\/publish\/([^/]+)\/files\/(.+)$/,
    );
    if (request.method === "PUT" && uploadMatch) {
      const versionId = uploadMatch[1] || "";
      const actorOrResponse = await publishActorForVersion(
        request,
        env,
        versionId,
      );
      if (actorOrResponse instanceof Response) return actorOrResponse;
      const actor = actorOrResponse;
      const assetPath = validateAssetPath(uploadMatch[2] || "");
      const version = await getVersionForOrg(env, actor.orgId, versionId);
      if (!version)
        return error(404, "version_not_found", "publish version not found");
      if (version.status !== "draft")
        return error(409, "version_not_draft", "version is not writable");
      const fileLimit = readLimit(env, "file");
      const contentLength = parseContentLength(request);
      if (contentLength instanceof Response) return contentLength;
      if (contentLength > fileLimit)
        return error(
          413,
          "file_too_large",
          "file exceeds configured file limit",
        );
      const contentType =
        request.headers.get("Content-Type") || mimeFor(assetPath);
      const sha256 = parseSha256(request);
      if (sha256 instanceof Response) return sha256;
      const previous = await getFile(env, version.id, assetPath);
      const storageKey = `orgs/${actor.orgId}/artifacts/${version.artifact_id}/versions/${version.id}/uploads/${randomId("upl")}/${assetPath}`;
      const putOptions: R2PutOptions = {
        httpMetadata: { contentType },
        customMetadata: { sha256 },
        sha256,
      };
      const put = await env.BUCKET.put(
        storageKey,
        request.body || new Uint8Array(),
        putOptions,
      );
      if (put.size > fileLimit) {
        await env.BUCKET.delete(storageKey);
        return error(
          413,
          "file_too_large",
          "file exceeds configured file limit",
        );
      }
      const upserted = await upsertFileIfDraft(
        env,
        actor.orgId,
        version.id,
        assetPath,
        storageKey,
        contentType,
        put.size,
        sha256,
      );
      if (!upserted) {
        await env.BUCKET.delete(storageKey);
        return error(409, "version_not_draft", "version is not writable");
      }
      if (previous && previous.storage_key !== storageKey)
        await env.BUCKET.delete(previous.storage_key);
      return json({
        ok: true,
        version_id: version.id,
        path: assetPath,
        size: put.size,
        storage_key: storageKey,
      });
    }

    const completeMatch = path.match(/^\/api\/v1\/publish\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const versionId = completeMatch[1] || "";
      const actorOrResponse = await publishActorForVersion(
        request,
        env,
        versionId,
      );
      if (actorOrResponse instanceof Response) return actorOrResponse;
      const actor = actorOrResponse;
      const version = await getVersionForOrg(env, actor.orgId, versionId);
      if (!version)
        return error(404, "version_not_found", "publish version not found");
      if (version.status !== "draft")
        return error(409, "version_not_draft", "version is not writable");
      const manifest = (await request.json()) as PublishManifest;
      const entrypoint = validateAssetPath(
        String(manifest.entrypoint || "index.html"),
      );
      if (entrypoint !== version.entrypoint)
        return error(
          400,
          "entrypoint_mismatch",
          "manifest entrypoint must match the draft entrypoint",
        );
      if (!(await claimVersionForCompletion(env, actor.orgId, version.id)))
        return error(409, "version_not_draft", "version is not writable");
      let completed = false;
      try {
        const validation = await validateManifest(
          env,
          version.id,
          manifest,
          readLimit(env, "package"),
          readLimit(env, "count"),
        );
        if (validation instanceof Response) {
          // A package over the size or count limit can never complete, so
          // keeping its files around only leaks storage (three such
          // rejections held 357 MB of R2 before this existed). Other
          // rejections leave the draft open for a corrected manifest.
          if (validation.status === 413) await purgeVersion(env, version);
          else await revertVersionToDraft(env, actor.orgId, version.id);
          return validation;
        }
        // The draft stays writable after a refusal so the client can re-PUT
        // the offending files and complete again.
        const findings = await scanUploadedFiles(env, validation.files);
        if (findings.length && !allowsSecrets(manifest)) {
          await revertVersionToDraft(env, actor.orgId, version.id);
          return secretsDetectedResponse(findings);
        }
        await completeVersion(
          env,
          version,
          JSON.stringify(validation.manifest),
          validation.totalSize,
          validation.manifest.files.length,
        );
        completed = true;
        let artifact = await env.DB.prepare(
          "SELECT * FROM artifacts WHERE id = ?",
        )
          .bind(version.artifact_id)
          .first<Artifact>();
        if (artifact && !artifact.description) {
          artifact = await addGeneratedDescription(env, artifact, version);
        }
        return json({
          ok: true,
          artifact,
          version_id: version.id,
          url: artifact ? publicArtifactUrl(env, artifact.url_key) : null,
          links: artifact
            ? publishLinks(env, artifact.url_key, version.id)
            : null,
          note: UNLISTED_NOTE,
          ...(findings.length ? { warnings: findings } : {}),
        });
      } catch (e) {
        if (!completed)
          await revertVersionToDraft(env, actor.orgId, version.id);
        throw e;
      }
    }

    if (request.method === "POST" && path === "/api/v1/publish/html") {
      const creatorOrResponse = await safeCreator(request, env);
      if (creatorOrResponse instanceof Response) return creatorOrResponse;
      const creator = creatorOrResponse;
      requirePermission(creator, env, "artifacts:publish");
      const suspended = await suspendedOrganizationResponse(env, creator.orgId);
      if (suspended) return suspended;
      const body = (await request.json()) as StartBody & { html?: string };
      const html = String(body.html || "");
      if (!html) return error(400, "html_required", "html is required");
      const bytes = new TextEncoder().encode(html);
      if (bytes.byteLength > readLimit(env, "file"))
        return error(413, "file_too_large", "html exceeds file limit");
      // Scan before anything is written: a refusal here creates no artifact.
      const findings =
        bytes.byteLength <= MAX_SCAN_BYTES
          ? scanForSecrets(html, "index.html")
          : [];
      if (findings.length && !allowsSecrets(body))
        return secretsDetectedResponse(findings);
      const conflict = await baseVersionConflict(env, creator, body);
      if (conflict) return conflict;
      // Pin the entrypoint after the spread so a caller-supplied one stays ignored.
      const draftBody = { ...body, entrypoint: "index.html" };
      if (body.description === undefined) {
        const generatedDescription = extractArtifactDescription(html);
        if (generatedDescription) draftBody.description = generatedDescription;
      }
      const { artifact, version } = await createDraft(env, creator, draftBody);
      const storageKey = `orgs/${creator.orgId}/artifacts/${version.artifact_id}/versions/${version.id}/files/index.html`;
      // Recorded so version diffs can tell an unchanged page from a changed
      // one by hash, like uploaded files.
      const sha256 = await sha256Hex(bytes);
      await env.BUCKET.put(storageKey, bytes, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { sha256 },
      });
      const upserted = await upsertFileIfDraft(
        env,
        creator.orgId,
        version.id,
        "index.html",
        storageKey,
        "text/html; charset=utf-8",
        bytes.byteLength,
        sha256,
      );
      if (!upserted)
        return error(409, "version_not_draft", "version is not writable");
      const manifest: PublishManifest = {
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            content_type: "text/html; charset=utf-8",
            size: bytes.byteLength,
            sha256,
          },
        ],
      };
      await completeVersion(
        env,
        version,
        JSON.stringify(manifest),
        bytes.byteLength,
        1,
      );
      return json({
        ok: true,
        artifact,
        version_id: version.id,
        url: publicArtifactUrl(env, artifact.url_key),
        links: publishLinks(env, artifact.url_key, version.id),
        note: UNLISTED_NOTE,
        ...(findings.length ? { warnings: findings } : {}),
      });
    }
  } catch (e) {
    return error(
      400,
      "publish_failed",
      e instanceof Error ? e.message : "publish failed",
    );
  }

  return error(404, "not_found", "publish route not found");
}

async function createDraft(
  env: Env,
  creator: Creator,
  body: StartBody,
): Promise<{
  artifact: Artifact;
  version: ArtifactVersion;
  upload_base: string;
  limits: { package_bytes: number; file_bytes: number; file_count: number };
}> {
  const artifactSlug = assertSlug("artifact", String(body.artifact || ""));
  // Pass absent title/gate_level through as null so upsertArtifact keeps the
  // existing values on republish instead of resetting them.
  const gateLevel = (body.gate_level || null) as GateLevel | null;
  if (gateLevel && !GATE_LEVELS.has(gateLevel))
    throw new Error("gate_level is not supported");
  const entrypoint = validateAssetPath(String(body.entrypoint || "index.html"));
  const artifact = await upsertArtifact(
    env,
    creator,
    artifactSlug,
    body.title || null,
    normalizeArtifactDescription(body.description),
    gateLevel,
  );
  const version = await createDraftVersion(env, creator, artifact, entrypoint);
  return {
    artifact,
    version,
    upload_base: `${env.SITE_BASE_URL}/api/v1/publish/${version.id}/files/`,
    limits: {
      package_bytes: readLimit(env, "package"),
      file_bytes: readLimit(env, "file"),
      file_count: readLimit(env, "count"),
    },
  };
}

async function addGeneratedDescription(
  env: Env,
  artifact: Artifact,
  version: ArtifactVersion,
): Promise<Artifact> {
  const file = await getFile(env, version.id, version.entrypoint);
  if (!file || !isHtml(file.content_type, file.path)) return artifact;
  try {
    const object = await env.BUCKET.get(file.storage_key, {
      range: { offset: 0, length: Math.min(file.size, 65_536) },
    });
    if (!object || !("body" in object)) return artifact;
    const description = extractArtifactDescription(await object.text());
    if (!description) return artifact;
    return updateArtifactPreview(env, artifact, undefined, description);
  } catch {
    // Summary generation is best-effort and must never make a successful
    // artifact publication fail.
    return artifact;
  }
}

function isHtml(contentType: string, path: string): boolean {
  return (
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/html" ||
    /\.html?$/i.test(path)
  );
}

// Read the text-like files of a draft back from R2 and scan them, within the
// publish-level caps. Binary and oversized files are skipped, not read.
async function scanUploadedFiles(
  env: Env,
  files: ArtifactFile[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const file of files) {
    if (scanned >= MAX_SCAN_FILES || findings.length >= MAX_FINDINGS) break;
    if (file.size > MAX_SCAN_BYTES) continue;
    if (!isTextLike(file.content_type, file.path)) continue;
    scanned += 1;
    const object = await env.BUCKET.get(file.storage_key);
    if (!object || !("body" in object)) continue;
    findings.push(
      ...scanForSecrets(
        await object.text(),
        file.path,
        MAX_FINDINGS - findings.length,
      ),
    );
  }
  return findings;
}

function secretsDetectedResponse(findings: Finding[]): Response {
  return json(
    {
      error: {
        code: "secrets_detected",
        message: secretsDetectedMessage(findings),
        findings,
      },
    },
    { status: 422 },
  );
}

async function publishActorForVersion(
  request: Request,
  env: Env,
  versionId: string,
): Promise<PublishActor | Response> {
  const token = bearerToken(request);
  // Creator tokens are also payload.sig shaped (au_creator_<payload>.<sig>),
  // so route them by prefix before structural sniffing — otherwise they get
  // misread as upload tokens and always fail verification.
  if (
    token &&
    !token.startsWith(CREATOR_TOKEN_PREFIX) &&
    token.split(".").length === 2
  ) {
    const upload = await verifyUploadToken(token, env);
    if (!upload)
      return authRequired(
        env,
        "invalid_upload_token",
        "upload token is invalid or expired",
      );
    if (upload.version_id !== versionId)
      return authRequired(
        env,
        "invalid_upload_token",
        "upload token does not match publish version",
      );
    return {
      orgId: upload.org_id,
      sub: upload.created_by,
    };
  }
  const creatorOrResponse = await safeCreator(request, env);
  if (creatorOrResponse instanceof Response) return creatorOrResponse;
  requirePermission(creatorOrResponse, env, "artifacts:publish");
  return {
    orgId: creatorOrResponse.orgId,
    sub: creatorOrResponse.sub,
  };
}

function parseContentLength(request: Request): number | Response {
  const raw = request.headers.get("Content-Length");
  if (!raw)
    return error(411, "content_length_required", "Content-Length is required");
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0)
    return error(400, "invalid_content_length", "Content-Length is invalid");
  return length;
}

function parseSha256(request: Request): string | Response {
  const sha256 = (request.headers.get("X-Artifact-Sha256") || "")
    .trim()
    .toLowerCase();
  if (!sha256)
    return error(400, "sha256_required", "X-Artifact-Sha256 is required");
  if (!/^[a-f0-9]{64}$/.test(sha256))
    return error(400, "invalid_sha256", "X-Artifact-Sha256 is invalid");
  return sha256;
}

// Clients that already know their package shape (every folder publisher does)
// can declare it up front and get the 413 before uploading anything.
function declaredLimitsResponse(env: Env, body: StartBody): Response | null {
  const count = Number(body.file_count);
  if (Number.isFinite(count) && count > readLimit(env, "count"))
    return error(
      413,
      "too_many_files",
      `file count ${count} exceeds the limit of ${readLimit(env, "count")}`,
    );
  const bytes = Number(body.package_bytes);
  if (Number.isFinite(bytes) && bytes > readLimit(env, "package"))
    return error(
      413,
      "package_too_large",
      `package size ${bytes} exceeds the limit of ${readLimit(env, "package")} bytes`,
    );
  return null;
}

// Optimistic concurrency for republishes. A caller that names the version it
// last saw (`base_version_id`) is refused when the artifact's current version
// is a different one: another agent or person published in between, and a
// blind republish would silently clobber their work. Checked before the
// draft exists, so a refusal creates nothing. An artifact that does not
// exist yet has no current version, which is also a conflict: the caller
// clearly expected to be republishing.
async function baseVersionConflict(
  env: Env,
  creator: Creator,
  body: StartBody,
): Promise<Response | null> {
  const base = String(body.base_version_id ?? "").trim();
  if (!base) return null;
  const ref = String(body.artifact || "");
  const existing = isSlug(ref)
    ? await findArtifactForPublish(env, creator.orgId, ref)
    : null;
  const currentId = existing?.current_version_id || null;
  if (currentId === base) return null;
  const current = currentId ? await getVersion(env, currentId) : null;
  return json(
    {
      error: {
        code: "version_conflict",
        message: currentId
          ? `the artifact's current version is ${currentId}, not base_version_id ${base}: someone published in between. Review the current version (artifact_manage versions or diff), merge, then republish with base_version_id set to ${currentId}.`
          : `base_version_id ${base} was given but the artifact has no published version yet; publish without base_version_id to create it.`,
        current_version_id: currentId,
        current_created_at: current?.created_at ?? null,
        current_url:
          existing && currentId
            ? versionUrl(env, existing.url_key, currentId)
            : null,
        base_version_id: base,
      },
    },
    { status: 409 },
  );
}

function uploadSessionTtl(value: unknown): number | Response {
  if (value === undefined || value === null || value === "") return 6 * 60 * 60;
  const ttl = Number(value);
  if (!Number.isFinite(ttl))
    return error(400, "invalid_ttl", "ttl_seconds must be a number");
  return Math.max(60, Math.min(6 * 60 * 60, Math.floor(ttl)));
}

async function validateManifest(
  env: Env,
  versionId: string,
  manifest: PublishManifest,
  packageLimit: number,
  fileCountLimit: number,
): Promise<
  | { totalSize: number; manifest: PublishManifest; files: ArtifactFile[] }
  | Response
> {
  if (!manifest || !Array.isArray(manifest.files))
    return error(400, "invalid_manifest", "manifest.files is required");
  const entrypoint = validateAssetPath(
    String(manifest.entrypoint || "index.html"),
  );
  const uploaded = await listFilesForVersion(env, versionId);
  if (
    uploaded.length > fileCountLimit ||
    manifest.files.length > fileCountLimit
  )
    return error(413, "too_many_files", "file count exceeds configured limit");
  if (uploaded.length !== manifest.files.length)
    return error(
      400,
      "manifest_mismatch",
      "manifest must include every uploaded file and no extra files",
    );
  const uploadedByPath = new Map(uploaded.map((file) => [file.path, file]));
  let totalSize = 0;
  const seen = new Set<string>();
  const canonical: ManifestFile[] = [];
  for (const f of manifest.files) {
    const path = validateAssetPath(String(f.path || ""));
    if (seen.has(path))
      return error(400, "duplicate_path", `duplicate path: ${path}`);
    seen.add(path);
    const row = uploadedByPath.get(path);
    if (!row)
      return error(400, "missing_file", `file was not uploaded: ${path}`);
    if (f.size !== undefined && Number(f.size) !== row.size)
      return error(400, "size_mismatch", `size mismatch: ${path}`);
    if (f.content_type && f.content_type !== row.content_type)
      return error(
        400,
        "content_type_mismatch",
        `content_type mismatch: ${path}`,
      );
    if (f.sha256 && f.sha256.toLowerCase() !== row.sha256)
      return error(400, "sha256_mismatch", `sha256 mismatch: ${path}`);
    totalSize += row.size;
    if (totalSize > packageLimit)
      return error(
        413,
        "package_too_large",
        "package exceeds configured limit",
      );
    canonical.push({
      path: row.path,
      content_type: row.content_type,
      size: row.size,
      sha256: row.sha256,
    });
  }
  if (!seen.has(entrypoint))
    return error(
      400,
      "missing_entrypoint",
      "entrypoint must be present in files",
    );
  return {
    totalSize,
    manifest: { entrypoint, files: canonical },
    files: uploaded,
  };
}
