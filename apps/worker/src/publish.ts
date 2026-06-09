import type {
  Artifact,
  Env,
  GateLevel,
  ManifestFile,
  PublishManifest,
} from "./types";
import { safeCreator, requirePermission } from "./auth";
import {
  completeVersion,
  createDraftVersion,
  ensureTenant,
  getVersionForOrg,
  upsertArtifact,
  upsertFile,
} from "./db";
import {
  assertSlug,
  error,
  GATE_LEVELS,
  json,
  mimeFor,
  readLimit,
  validateAssetPath,
} from "./util";

interface StartBody {
  tenant: string;
  artifact: string;
  title?: string;
  gate_level?: GateLevel;
  entrypoint?: string;
}

export async function handlePublish(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const creatorOrResponse = await safeCreator(request, env);
  if (creatorOrResponse instanceof Response) return creatorOrResponse;
  const creator = creatorOrResponse;

  try {
    if (request.method === "POST" && path === "/api/v1/publish/start") {
      requirePermission(creator, env, "artifacts:publish");
      const body = (await request.json()) as StartBody;
      const tenantSlug = assertSlug("tenant", String(body.tenant || ""));
      const artifactSlug = assertSlug("artifact", String(body.artifact || ""));
      const gateLevel = (body.gate_level || "email") as GateLevel;
      if (!GATE_LEVELS.has(gateLevel))
        return error(400, "invalid_gate_level", "gate_level is not supported");
      const entrypoint = validateAssetPath(
        String(body.entrypoint || "index.html"),
      );
      await ensureTenant(env, creator, tenantSlug);
      const artifact = await upsertArtifact(
        env,
        creator,
        tenantSlug,
        artifactSlug,
        body.title || artifactSlug,
        gateLevel,
      );
      const version = await createDraftVersion(
        env,
        creator,
        artifact,
        entrypoint,
      );
      return json({
        artifact,
        version,
        upload_base: `${env.SITE_BASE_URL}/api/v1/publish/${version.id}/files/`,
        limits: {
          package_bytes: readLimit(env, "package"),
          file_bytes: readLimit(env, "file"),
          file_count: readLimit(env, "count"),
        },
      });
    }

    const uploadMatch = path.match(
      /^\/api\/v1\/publish\/([^/]+)\/files\/(.+)$/,
    );
    if (request.method === "PUT" && uploadMatch) {
      requirePermission(creator, env, "artifacts:publish");
      const versionId = uploadMatch[1] || "";
      const assetPath = validateAssetPath(uploadMatch[2] || "");
      const version = await getVersionForOrg(env, creator.orgId, versionId);
      if (!version)
        return error(404, "version_not_found", "publish version not found");
      if (version.status !== "draft")
        return error(409, "version_not_draft", "version is not writable");
      const contentLength = Number(
        request.headers.get("Content-Length") || "0",
      );
      if (contentLength > readLimit(env, "file"))
        return error(
          413,
          "file_too_large",
          "file exceeds configured file limit",
        );
      const contentType =
        request.headers.get("Content-Type") || mimeFor(assetPath);
      const sha256 = request.headers.get("X-Artifact-Sha256");
      const storageKey = `orgs/${creator.orgId}/artifacts/${version.artifact_id}/versions/${version.id}/files/${assetPath}`;
      const putOptions: R2PutOptions = {
        httpMetadata: { contentType },
      };
      if (sha256) putOptions.customMetadata = { sha256 };
      await env.BUCKET.put(
        storageKey,
        request.body || new Uint8Array(),
        putOptions,
      );
      const head = await env.BUCKET.head(storageKey);
      await upsertFile(
        env,
        version.id,
        assetPath,
        storageKey,
        contentType,
        Number(head?.size || contentLength),
        sha256,
      );
      return json({
        ok: true,
        version_id: version.id,
        path: assetPath,
        size: Number(head?.size || contentLength),
        storage_key: storageKey,
      });
    }

    const completeMatch = path.match(/^\/api\/v1\/publish\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      requirePermission(creator, env, "artifacts:publish");
      const versionId = completeMatch[1] || "";
      const version = await getVersionForOrg(env, creator.orgId, versionId);
      if (!version)
        return error(404, "version_not_found", "publish version not found");
      if (version.status !== "draft")
        return error(409, "version_not_draft", "version is not writable");
      const manifest = (await request.json()) as PublishManifest;
      const validation = await validateManifest(
        env,
        version.id,
        manifest,
        readLimit(env, "package"),
        readLimit(env, "count"),
      );
      if (validation instanceof Response) return validation;
      await completeVersion(
        env,
        version,
        JSON.stringify(manifest),
        validation.totalSize,
        manifest.files.length,
      );
      const artifact = await env.DB.prepare(
        "SELECT * FROM artifacts WHERE id = ?",
      )
        .bind(version.artifact_id)
        .first<Artifact>();
      return json({
        ok: true,
        artifact,
        version_id: version.id,
        url: artifact
          ? `${env.SITE_BASE_URL}/${artifact.tenant_slug}/${artifact.slug}/`
          : null,
      });
    }

    if (request.method === "POST" && path === "/api/v1/publish/html") {
      requirePermission(creator, env, "artifacts:publish");
      const body = (await request.json()) as StartBody & { html?: string };
      const html = String(body.html || "");
      if (!html) return error(400, "html_required", "html is required");
      if (new TextEncoder().encode(html).byteLength > readLimit(env, "file"))
        return error(413, "file_too_large", "html exceeds file limit");
      const tenantSlug = assertSlug("tenant", String(body.tenant || ""));
      const artifactSlug = assertSlug("artifact", String(body.artifact || ""));
      const gateLevel = (body.gate_level || "email") as GateLevel;
      if (!GATE_LEVELS.has(gateLevel))
        return error(400, "invalid_gate_level", "gate_level is not supported");
      await ensureTenant(env, creator, tenantSlug);
      const artifact = await upsertArtifact(
        env,
        creator,
        tenantSlug,
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
        url: `${env.SITE_BASE_URL}/${tenantSlug}/${artifactSlug}/`,
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

async function validateManifest(
  env: Env,
  versionId: string,
  manifest: PublishManifest,
  packageLimit: number,
  fileCountLimit: number,
): Promise<{ totalSize: number } | Response> {
  if (!manifest || !Array.isArray(manifest.files))
    return error(400, "invalid_manifest", "manifest.files is required");
  const entrypoint = validateAssetPath(
    String(manifest.entrypoint || "index.html"),
  );
  if (!manifest.files.some((f) => f.path === entrypoint))
    return error(
      400,
      "missing_entrypoint",
      "entrypoint must be present in files",
    );
  if (manifest.files.length > fileCountLimit)
    return error(413, "too_many_files", "file count exceeds configured limit");
  let totalSize = 0;
  const seen = new Set<string>();
  for (const f of manifest.files) {
    const path = validateAssetPath(String(f.path || ""));
    if (seen.has(path))
      return error(400, "duplicate_path", `duplicate path: ${path}`);
    seen.add(path);
    const row = await env.DB.prepare(
      "SELECT * FROM artifact_files WHERE version_id = ? AND path = ?",
    )
      .bind(versionId, path)
      .first<ManifestFile>();
    if (!row)
      return error(400, "missing_file", `file was not uploaded: ${path}`);
    totalSize += Number((row as { size?: number }).size || f.size || 0);
    if (totalSize > packageLimit)
      return error(
        413,
        "package_too_large",
        "package exceeds configured limit",
      );
  }
  return { totalSize };
}
