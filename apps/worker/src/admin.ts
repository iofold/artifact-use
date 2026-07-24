import type { Artifact, Creator, Env, GateLevel } from "./types";
import { mintCreatorToken, requirePermission, safeCreator } from "./auth";
import {
  listWorkspaces,
  resolveWorkspaceOrg,
  type WorkspaceRow,
} from "./workspaces";
import {
  createComment,
  listComments,
  positiveInteger,
  resolveComment,
} from "./comments";
import { agentSetupPrompt } from "./llms";
import { commentWriteRateLimit } from "./rl";
import {
  createShareLink,
  deleteArtifact,
  getArtifactByLegacyPath,
  getArtifactByUrlKey,
  getArtifactForOrg,
  listArtifactsForOrg,
  moveArtifactToOrg,
  updateArtifactAccess,
  updateArtifactPreview,
} from "./db";
import { normalizeArtifactDescription } from "./preview";
import {
  error,
  GATE_LEVELS,
  json,
  nowSec,
  normalizeEmail,
  publicArtifactUrl,
} from "./util";

const ARTIFACT_ACTIONS = new Set(["stats", "share-links", "comments", "move"]);

export async function handleAdminApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  // Identity-introspection routes stay reachable for user-scoped tokens that
  // have not named a workspace yet; everything else requires the selection.
  const laxWorkspace = path === "/api/v1/me" || path === "/api/v1/workspaces";
  const creatorOrResponse = await safeCreator(request, env, { laxWorkspace });
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
          token_scope: creator.tokenScope || null,
          workspace_selected: Boolean(creator.workspaceSelected),
        },
      });
    }

    if (request.method === "GET" && path === "/api/v1/workspaces") {
      requirePermission(creator, env, "artifacts:read");
      const workspaces = await listWorkspacesSafe(env, creator);
      return json({
        token_scope: creator.tokenScope || null,
        active_org_id: creator.workspaceSelected ? creator.orgId : null,
        workspaces,
        usage:
          creator.tokenScope === "user"
            ? `this credential publishes to any workspace listed here; pass workspace (org id or slug) on every publish/manage call`
            : `this credential is pinned to its workspace; the list shows every workspace its user belongs to`,
      });
    }

    if (request.method === "GET" && path === "/api/v1/artifacts") {
      requirePermission(creator, env, "artifacts:read");
      return json({
        artifacts: await listArtifactsForOrg(env, creator.orgId),
      });
    }

    if (path === "/api/v1/tokens") {
      // Creator tokens must not mint further tokens — a leaked token could
      // otherwise extend its own life forever. OAuth/JWT identities only.
      if (creator.raw.creator_token)
        return error(
          403,
          "token_mint_forbidden",
          "creator tokens cannot mint tokens; authenticate with WorkOS OAuth, or ask a human to generate one at /admin",
        );
      if (request.method === "GET") {
        requirePermission(creator, env, "artifacts:read");
        const rows = await env.DB.prepare(
          `SELECT id, label, source, created_at, expires_at FROM creator_tokens
           WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC LIMIT 50`,
        )
          .bind(creator.orgId, nowSec())
          .all();
        return json({ tokens: rows.results || [] });
      }
      if (request.method === "POST") {
        requirePermission(creator, env, "artifacts:manage_access");
        const body = (await request.json().catch(() => ({}))) as {
          label?: unknown;
          expires_days?: unknown;
          scope?: unknown;
        };
        const minted = await mintCreatorToken(env, {
          sub: creator.sub,
          orgId: creator.orgId,
          email: creator.email,
          label: body.label ? String(body.label).slice(0, 80) : null,
          source: "api",
          expiresDays: Number(body.expires_days) || 30,
          scope: body.scope === "user" ? "user" : "org",
        });
        return json({
          token: minted.token,
          token_id: minted.id,
          token_type: "Bearer",
          expires_at: minted.expiresAt,
          prompt: agentSetupPrompt(env, minted.token, minted.expiresAt),
        });
      }
      return error(405, "method_not_allowed", "method not allowed");
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
        description?: string | null;
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
      let updated = artifact;
      if (level || allowlistJson !== undefined) {
        updated = await updateArtifactAccess(
          env,
          updated,
          null,
          level,
          allowlistJson,
        );
      }
      if (body.title !== undefined || body.description !== undefined) {
        updated = await updateArtifactPreview(
          env,
          updated,
          body.title === undefined ? undefined : String(body.title),
          body.description === undefined
            ? undefined
            : normalizeArtifactDescription(body.description),
        );
      }
      return json({ artifact: updated });
    }

    // Self-serve move between the caller's own workspaces: membership in the
    // target is the whole authorization; created_by is preserved (gifting to
    // another user stays a super-admin web operation).
    if (request.method === "POST" && parsed.action === "move") {
      requirePermission(creator, env, "artifacts:manage_access");
      const body = (await request.json().catch(() => ({}))) as {
        workspace?: string;
      };
      const requested = String(body.workspace || "").trim();
      if (!requested)
        return error(
          400,
          "invalid_workspace",
          "workspace (target org id or slug) is required",
        );
      let targetOrgId: string;
      try {
        targetOrgId = await resolveWorkspaceOrg(env, creator.sub, requested);
      } catch (e) {
        return error(
          403,
          "workspace_forbidden",
          e instanceof Error
            ? e.message
            : "you are not a member of the target workspace",
        );
      }
      if (targetOrgId === artifact.org_id)
        return error(
          400,
          "same_workspace",
          "artifact is already in that workspace",
        );
      const slug = await moveArtifactToOrg(env, artifact, targetOrgId, {
        newOwner: null,
        actor: creator.sub,
        action: "move_artifact",
      });
      return json({
        ok: true,
        artifact: { ...artifact, org_id: targetOrgId, slug },
        note: "public url_key is unchanged; manage the artifact via the target workspace from now on",
      });
    }

    if (request.method === "DELETE" && !parsed.action) {
      requirePermission(creator, env, "artifacts:manage_access");
      await deleteArtifact(env, artifact);
      return json({ ok: true, deleted: artifact.url_key });
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

    // Creator-side comments: the publish -> collect feedback -> fix ->
    // republish -> resolve loop, driven by the owner's own bearer token.
    if (parsed.action === "comments") {
      if (request.method === "GET") {
        requirePermission(creator, env, "artifacts:read");
        const q = new URL(request.url).searchParams;
        return json(
          await listComments(env, artifact, {
            status: q.get("status"),
            since: Number(q.get("since")) || null,
            pagePath: q.get("page_path"),
            limit: Number(q.get("limit")) || null,
          }),
        );
      }
      if (request.method === "POST") {
        requirePermission(creator, env, "artifacts:publish");
        const body = (await request.json()) as {
          body?: string;
          parent_id?: unknown;
          target?: unknown;
          page_path?: unknown;
          version_id?: unknown;
        };
        const identity = creator.email || creator.sub;
        const limited = await commentWriteRateLimit(request, env, identity);
        if (limited) return limited;
        const result = await createComment(
          env,
          artifact,
          { email: identity, viewId: null },
          body,
        );
        if (!result.ok)
          return error(result.status, result.code, result.message);
        return json({ ok: true, comment: result.comment });
      }
      if (request.method === "PATCH") {
        requirePermission(creator, env, "artifacts:publish");
        const body = (await request.json()) as {
          id?: unknown;
          resolved?: unknown;
        };
        const id = positiveInteger(body.id);
        if (!id) return error(400, "invalid_comment", "comment id is required");
        const identity = creator.email || creator.sub;
        const limited = await commentWriteRateLimit(request, env, identity);
        if (limited) return limited;
        const updated = await resolveComment(
          env,
          artifact,
          id,
          body.resolved !== false,
          identity,
        );
        if (!updated)
          return error(404, "comment_not_found", "comment not found");
        return json({ ok: true, comment: updated });
      }
      return error(405, "method_not_allowed", "method not allowed");
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

// The membership list when WorkOS can provide one; otherwise degrade to the
// credential's own workspace so the route stays useful in keyless dev setups.
async function listWorkspacesSafe(
  env: Env,
  creator: Creator,
): Promise<WorkspaceRow[]> {
  try {
    const rows = await listWorkspaces(env, creator.sub);
    if (rows.length) return rows;
  } catch {
    // fall through to the credential's own workspace
  }
  return creator.orgId
    ? [{ org_id: creator.orgId, org_name: "", org_slug: "", role: "" }]
    : [];
}

interface ParsedArtifactPath {
  ref?: string;
  legacyPrefix?: string;
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
      legacyPrefix: assertArtifactRef(segments[0] || ""),
      legacyArtifact: assertArtifactRef(segments[1] || ""),
      action: "",
    };
  }
  return {
    legacyPrefix: assertArtifactRef(segments[0] || ""),
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
  if (parsed.legacyPrefix && parsed.legacyArtifact) {
    return getArtifactByLegacyPath(
      env,
      parsed.legacyPrefix,
      parsed.legacyArtifact,
    );
  }
  return null;
}

function assertArtifactRef(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(value))
    throw new Error("artifact reference must be lower-case hyphen-case");
  return value;
}
