import type { Artifact, Env, GateLevel } from "./types";
import { requirePermission, safeCreator } from "./auth";
import {
  createShareLink,
  getArtifactByLegacyPath,
  getArtifactByPath,
  getArtifactByUrlKey,
  getArtifactForOrg,
  listArtifactsForOrg,
  updateArtifactAccess,
} from "./db";
import {
  error,
  GATE_LEVELS,
  json,
  nowSec,
  normalizeEmail,
  publicArtifactUrl,
} from "./util";

const ARTIFACT_ACTIONS = new Set(["stats", "share-links", "comments"]);

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
      return json({
        creator: {
          sub: creator.sub,
          org_id: creator.orgId,
          email: creator.email,
          permissions: [...creator.permissions],
        },
      });
    }

    if (
      path === "/api/v1/tenant" ||
      path === "/api/v1/tenants" ||
      path.startsWith("/api/v1/tenants/")
    ) {
      return error(410, "tenant_removed", "tenant prefixes have been removed");
    }

    if (request.method === "GET" && path === "/api/v1/artifacts") {
      requirePermission(creator, env, "artifacts:read");
      return json({
        artifacts: await listArtifactsForOrg(env, creator.orgId),
      });
    }

    const parsed = parseArtifactApiPath(path);
    if (!parsed) return error(404, "not_found", "admin route not found");
    const artifact = await apiArtifact(env, creator.orgId, parsed);
    if (!artifact || artifact.org_id !== creator.orgId)
      return error(404, "artifact_not_found", "artifact not found");

    if (request.method === "GET" && !parsed.action) {
      requirePermission(creator, env, "artifacts:read");
      return json({ artifact });
    }

    if (request.method === "PATCH" && !parsed.action) {
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

    if (request.method === "POST" && parsed.action === "share-links") {
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
        url: `${publicArtifactUrl(env, artifact.url_key)}?v=${id}`,
        expires_at: expiresAt,
      });
    }

    if (request.method === "GET" && parsed.action === "stats") {
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

    if (request.method === "GET" && parsed.action === "comments") {
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

interface ParsedArtifactPath {
  ref?: string;
  legacyTenant?: string;
  legacyArtifact?: string;
  action: string;
}

function parseArtifactApiPath(path: string): ParsedArtifactPath | null {
  const prefix = "/api/v1/artifacts/";
  if (!path.startsWith(prefix)) return null;
  const segments = path
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (!segments.length || segments.length > 3) return null;
  if (segments.length === 1) {
    return { ref: assertArtifactRef(segments[0] || ""), action: "" };
  }
  if (segments.length === 2 && ARTIFACT_ACTIONS.has(segments[1] || "")) {
    return {
      ref: assertArtifactRef(segments[0] || ""),
      action: segments[1] || "",
    };
  }
  if (segments.length === 2) {
    return {
      legacyTenant: assertArtifactRef(segments[0] || ""),
      legacyArtifact: assertArtifactRef(segments[1] || ""),
      action: "",
    };
  }
  return {
    legacyTenant: assertArtifactRef(segments[0] || ""),
    legacyArtifact: assertArtifactRef(segments[1] || ""),
    action: segments[2] || "",
  };
}

async function apiArtifact(
  env: Env,
  orgId: string,
  parsed: ParsedArtifactPath,
): Promise<Artifact | null> {
  if (parsed.ref) {
    const byKey = await getArtifactByUrlKey(env, parsed.ref);
    if (byKey) return byKey;
    return getArtifactForOrg(env, orgId, parsed.ref);
  }
  if (parsed.legacyTenant && parsed.legacyArtifact) {
    return (
      (await getArtifactByPath(
        env,
        parsed.legacyTenant,
        parsed.legacyArtifact,
      )) ||
      getArtifactByLegacyPath(env, parsed.legacyTenant, parsed.legacyArtifact)
    );
  }
  return null;
}

function assertArtifactRef(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(value))
    throw new Error("artifact reference must be lower-case hyphen-case");
  return value;
}
