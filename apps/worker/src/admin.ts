import type { Env, GateLevel } from "./types";
import { requirePermission, safeCreator } from "./auth";
import {
  createShareLink,
  ensureTenant,
  getArtifactByPath,
  getTenantForOrg,
  listArtifactsForOrg,
  updateArtifactAccess,
} from "./db";
import {
  assertSlug,
  error,
  GATE_LEVELS,
  json,
  nowSec,
  normalizeEmail,
  publicArtifactUrl,
} from "./util";

export async function handleAdminApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const creatorOrResponse = await safeCreator(request, env);
  if (creatorOrResponse instanceof Response) return creatorOrResponse;
  const creator = creatorOrResponse;

  try {
    if (request.method === "GET" && path === "/api/v1/me") {
      const tenant = await getTenantForOrg(env, creator.orgId);
      return json({
        creator: {
          sub: creator.sub,
          org_id: creator.orgId,
          email: creator.email,
          permissions: [...creator.permissions],
        },
        tenant,
      });
    }

    if (request.method === "POST" && path === "/api/v1/tenants") {
      requirePermission(creator, env, "artifacts:publish");
      const body = (await request.json()) as { tenant?: string; name?: string };
      const tenant = await ensureTenant(
        env,
        creator,
        assertSlug("tenant", String(body.tenant || "")),
        body.name || null,
      );
      return json({ tenant });
    }

    if (request.method === "GET" && path === "/api/v1/tenant") {
      requirePermission(creator, env, "artifacts:read");
      const tenant = await getTenantForOrg(env, creator.orgId);
      return json({ tenant });
    }

    if (request.method === "GET" && path === "/api/v1/artifacts") {
      requirePermission(creator, env, "artifacts:read");
      const tenant = await getTenantForOrg(env, creator.orgId);
      return json({
        tenant,
        default_tenant: tenant?.slug || null,
        artifacts: await listArtifactsForOrg(env, creator.orgId),
      });
    }

    const match = path.match(
      /^\/api\/v1\/artifacts\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (!match) return error(404, "not_found", "admin route not found");
    const tenantSlug = assertSlug("tenant", match[1] || "");
    const artifactSlug = assertSlug("artifact", match[2] || "");
    const action = match[3] || "";
    const artifact = await getArtifactByPath(env, tenantSlug, artifactSlug);
    if (!artifact || artifact.org_id !== creator.orgId)
      return error(404, "artifact_not_found", "artifact not found");

    if (request.method === "GET" && !action) {
      requirePermission(creator, env, "artifacts:read");
      return json({ artifact });
    }

    if (request.method === "PATCH" && !action) {
      requirePermission(creator, env, "artifacts:manage_access");
      const body = (await request.json()) as {
        title?: string;
        gate_level?: GateLevel;
        allowlist?: unknown;
      };
      const level = body.gate_level || null;
      if (level && !GATE_LEVELS.has(level))
        return error(400, "invalid_gate_level", "gate_level is not supported");
      const allowlistJson =
        body.allowlist === undefined
          ? undefined
          : JSON.stringify(body.allowlist);
      const updated = await updateArtifactAccess(
        env,
        artifact,
        body.title || null,
        level,
        allowlistJson,
      );
      return json({ artifact: updated });
    }

    if (request.method === "POST" && action === "share-links") {
      requirePermission(creator, env, "artifacts:manage_access");
      const body = (await request.json()) as {
        recipient_email?: string;
        recipient_label?: string;
        expires_days?: number;
      };
      const expiresAt = body.expires_days
        ? nowSec() +
          Math.max(1, Math.min(365, Number(body.expires_days))) * 86400
        : null;
      const id = await createShareLink(
        env,
        artifact,
        creator,
        body.recipient_email ? normalizeEmail(body.recipient_email) : null,
        body.recipient_label || null,
        expiresAt,
      );
      return json({
        id,
        url: `${publicArtifactUrl(env, artifact.tenant_slug, artifact.slug)}?v=${id}`,
        expires_at: expiresAt,
      });
    }

    if (request.method === "GET" && action === "stats") {
      requirePermission(creator, env, "artifacts:view_stats");
      const views = await env.DB.prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT email) AS unique_viewers, MAX(ts) AS last_ts FROM views WHERE artifact_id = ?",
      )
        .bind(artifact.id)
        .first();
      const recent = await env.DB.prepare(
        "SELECT email, verified, ts, referrer FROM views WHERE artifact_id = ? ORDER BY ts DESC LIMIT 50",
      )
        .bind(artifact.id)
        .all();
      const links = await env.DB.prepare(
        `SELECT sl.*, COUNT(v.id) AS view_count
         FROM share_links sl
         LEFT JOIN views v ON v.share_link_id = sl.id
         WHERE sl.artifact_id = ?
         GROUP BY sl.id
         ORDER BY sl.created_at DESC`,
      )
        .bind(artifact.id)
        .all();
      return json({
        artifact,
        views,
        recent: recent.results || [],
        links: links.results || [],
      });
    }

    if (request.method === "GET" && action === "comments") {
      requirePermission(creator, env, "artifacts:read");
      const rows = await env.DB.prepare(
        "SELECT * FROM comments WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
      )
        .bind(artifact.id)
        .all();
      return json({ comments: rows.results || [] });
    }
  } catch (e) {
    return error(
      400,
      "admin_failed",
      e instanceof Error ? e.message : "admin operation failed",
    );
  }

  return error(404, "not_found", "admin route not found");
}
