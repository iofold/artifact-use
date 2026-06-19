import type {
  Artifact,
  ArtifactVersion,
  Creator,
  Env,
  GateLevel,
  ManifestFile,
  PublishManifest,
} from "./types";
import {
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
  getFile,
  getVersionForOrg,
  listFilesForVersion,
  revertVersionToDraft,
  upsertArtifact,
  upsertFile,
  upsertFileIfDraft,
} from "./db";
import {
  assertSlug,
  error,
  GATE_LEVELS,
  json,
  mimeFor,
  nowSec,
  publicArtifactUrl,
  randomId,
  readLimit,
  validateAssetPath,
} from "./util";

interface StartBody {
  artifact: string;
  title?: string;
  gate_level?: GateLevel;
  entrypoint?: string;
  ttl_seconds?: number;
}

interface PublishActor {
  orgId: string;
  sub: string | null;
}

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
      const body = (await request.json()) as StartBody;
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
      const body = (await request.json()) as StartBody;
      const ttl = uploadSessionTtl(body.ttl_seconds);
      if (ttl instanceof Response) return ttl;
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
        sha256: hexToBytes(sha256),
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
      const latest = await getVersionForOrg(env, actor.orgId, versionId);
      if (!latest || latest.status !== "draft") {
        await env.BUCKET.delete(storageKey);
        return error(409, "version_not_draft", "version is not writable");
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
          await revertVersionToDraft(env, actor.orgId, version.id);
          return validation;
        }
        await completeVersion(
          env,
          version,
          JSON.stringify(validation.manifest),
          validation.totalSize,
          validation.manifest.files.length,
        );
        completed = true;
        const artifact = await env.DB.prepare(
          "SELECT * FROM artifacts WHERE id = ?",
        )
          .bind(version.artifact_id)
          .first<Artifact>();
        return json({
          ok: true,
          artifact,
          version_id: version.id,
          url: artifact ? publicArtifactUrl(env, artifact.url_key) : null,
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
      const body = (await request.json()) as StartBody & { html?: string };
      const html = String(body.html || "");
      if (!html) return error(400, "html_required", "html is required");
      if (new TextEncoder().encode(html).byteLength > readLimit(env, "file"))
        return error(413, "file_too_large", "html exceeds file limit");
      const artifactSlug = assertSlug("artifact", String(body.artifact || ""));
      const gateLevel = (body.gate_level || "email") as GateLevel;
      if (!GATE_LEVELS.has(gateLevel))
        return error(400, "invalid_gate_level", "gate_level is not supported");
      const artifact = await upsertArtifact(
        env,
        creator,
        artifactSlug,
        body.title || artifactSlug,
        gateLevel,
      );
      const version = await createDraftVersion(
        env,
        creator,
        artifact,
        "index.html",
      );
      const storageKey = `orgs/${creator.orgId}/artifacts/${version.artifact_id}/versions/${version.id}/files/index.html`;
      const bytes = new TextEncoder().encode(html);
      await env.BUCKET.put(storageKey, bytes, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      await upsertFile(
        env,
        version.id,
        "index.html",
        storageKey,
        "text/html; charset=utf-8",
        bytes.byteLength,
        null,
      );
      const manifest: PublishManifest = {
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            content_type: "text/html; charset=utf-8",
            size: bytes.byteLength,
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
  const gateLevel = (body.gate_level || "email") as GateLevel;
  if (!GATE_LEVELS.has(gateLevel))
    throw new Error("gate_level is not supported");
  const entrypoint = validateAssetPath(String(body.entrypoint || "index.html"));
  const artifact = await upsertArtifact(
    env,
    creator,
    artifactSlug,
    body.title || artifactSlug,
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

async function publishActorForVersion(
  request: Request,
  env: Env,
  versionId: string,
): Promise<PublishActor | Response> {
  const token = bearerToken(request);
  if (token && token.split(".").length === 2) {
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

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
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

function uploadSessionTtl(value: unknown): number | Response {
  if (value === undefined || value === null || value === "") return 6 * 60 * 60;
  const ttl = Number(value);
  if (!Number.isFinite(ttl))
    return error(400, "invalid_ttl", "ttl_seconds must be a number");
  return Math.max(60, Math.min(6 * 60 * 60, Math.floor(ttl)));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function validateManifest(
  env: Env,
  versionId: string,
  manifest: PublishManifest,
  packageLimit: number,
  fileCountLimit: number,
): Promise<{ totalSize: number; manifest: PublishManifest } | Response> {
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
  return { totalSize, manifest: { entrypoint, files: canonical } };
}
