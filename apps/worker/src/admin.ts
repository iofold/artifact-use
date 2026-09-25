import type { Artifact, Creator, Env, GateLevel } from "./types";
import {
  DEFAULT_TOKEN_DAYS,
  mintCreatorToken,
  requirePermission,
  safeCreator,
} from "./auth";
import {
  listWorkspaces,
  resolveWorkspaceOrg,
  type WorkspaceRow,
} from "./workspaces";
import {
  clampWait,
  createComment,
  creatorAgentLabel,
  creatorCommentAuthor,
  listComments,
  positiveInteger,
  resolveComment,
  touchArtifactWatch,
  waitForComments,
} from "./comments";
import { agentSetupPrompt } from "./llms";
import { commentWriteRateLimit } from "./rl";
import {
  clearArtifactUpstream,
  createShareLink,
  deleteArtifact,
  getArtifactByLegacyPath,
  getArtifactByUrlKey,
  getArtifactForOrg,
  getArtifactUpstream,
  listArtifactsForOrg,
  listShareLinks,
  moveArtifactToOrg,
  revokeShareLink,
  setArtifactUpstream,
  updateArtifactAccess,
  updateArtifactPreview,
} from "./db";
import { validEmail } from "./gate";
import {
  PASSCODE_MAX,
  PASSCODE_MIN,
  SHARE_LINK_KINDS,
  type ShareLinkKind,
  UNLISTED_NOTE,
  gateLevelForPreset,
  generatePasscode,
  hashPasscode,
  normalizePasscode,
  randomSalt,
  shareLinkJson,
} from "./links";
import { normalizeArtifactDescription } from "./preview";
import { normalizeUpstreamUrl, upstreamSummary } from "./upstream";
import {
  error,
  GATE_LEVELS,
  json,
  nowSec,
  normalizeEmail,
  publicArtifactPath,
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
          expiresDays: Number(body.expires_days) || DEFAULT_TOKEN_DAYS,
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
      return json({
        artifact,
        upstream: upstreamSummary(
          await getArtifactUpstream(env, artifact.id),
          publicArtifactPath(env, artifact.url_key),
        ),
      });
    }

    if (request.method === "PATCH" && !parsed.action) {
      requirePermission(creator, env, "artifacts:manage_access");
      const body = (await request.json()) as {
        title?: string;
        description?: string | null;
        gate_level?: GateLevel;
        access_preset?: unknown;
        allowlist?: unknown;
        upstream?: { base_url?: unknown; secret?: unknown } | null;
      };
      // `access_preset` is a friendlier spelling of the same four levels:
      // open, email, client (= verified_email), restricted (= allowlist).
      if (
        body.access_preset !== undefined &&
        !gateLevelForPreset(body.access_preset)
      )
        return error(
          400,
          "invalid_access_preset",
          "access_preset must be one of open, email, client, restricted",
        );
      const level =
        body.gate_level || gateLevelForPreset(body.access_preset) || null;
      if (level && !GATE_LEVELS.has(level))
        return error(400, "invalid_gate_level", "gate_level is not supported");
      const allowlistJson =
        body.allowlist === undefined
          ? undefined
          : JSON.stringify(body.allowlist);
      let updated = artifact;
      // An upstream backend is only reachable through a gate (see
      // upstream.ts); never let the two be combined from either direction.
      if (level === "public" && (await getArtifactUpstream(env, artifact.id)))
        return error(
          409,
          "upstream_requires_gate",
          "this artifact has an upstream backend; clear it before making the artifact public",
        );
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
      // Upstream backend: `null` clears it; an object replaces both fields, so
      // a URL change must resend the secret. The secret is write-only.
      if (body.upstream === null) {
        await clearArtifactUpstream(env, updated);
      } else if (body.upstream !== undefined) {
        if (typeof body.upstream !== "object")
          return error(
            400,
            "invalid_upstream",
            "upstream must be null or { base_url, secret? }",
          );
        const baseUrl = normalizeUpstreamUrl(
          String(body.upstream.base_url || ""),
          env,
        );
        if (!baseUrl)
          return error(
            400,
            "invalid_upstream",
            "upstream.base_url must be an https:// URL to a public hostname (no IP literals, credentials, query, or fragment)",
          );
        const secret =
          body.upstream.secret === undefined || body.upstream.secret === null
            ? null
            : String(body.upstream.secret);
        if (secret !== null && (!secret.trim() || secret.length > 1024))
          return error(
            400,
            "invalid_upstream",
            "upstream.secret must be a non-empty string of at most 1024 characters",
          );
        if (updated.gate_level === "public")
          return error(
            409,
            "upstream_requires_gate",
            "upstream backends require a gated artifact; set gate_level to email, verified_email or allowlist first",
          );
        await setArtifactUpstream(env, updated, baseUrl, secret, creator.sub);
      }
      return json({
        artifact: updated,
        upstream: upstreamSummary(
          await getArtifactUpstream(env, updated.id),
          publicArtifactPath(env, updated.url_key),
        ),
      });
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

    if (parsed.action === "share-links") {
      // Links are credentials (an open link passes the gate outright), so
      // listing them is a manage_access operation, like minting one.
      requirePermission(creator, env, "artifacts:manage_access");
      if (request.method === "GET" && !parsed.sub) {
        const links = await listShareLinks(env, artifact.id);
        return json({
          links: links.map((link) =>
            shareLinkJson(env, artifact.url_key, link),
          ),
        });
      }
      if (request.method === "DELETE" && parsed.sub) {
        const revoked = await revokeShareLink(env, artifact.id, parsed.sub);
        if (!revoked)
          return error(
            404,
            "link_not_found",
            "share link not found or already revoked",
          );
        return json({ ok: true, id: parsed.sub, state: "revoked" });
      }
      if (request.method === "POST" && !parsed.sub) {
        const body = (await request.json().catch(() => ({}))) as {
          kind?: unknown;
          recipient_email?: unknown;
          recipient_label?: unknown;
          label?: unknown;
          passcode?: unknown;
          expires_days?: unknown;
          max_opens?: unknown;
        };
        const created = await createShareLinkFromInput(
          env,
          artifact,
          creator,
          body,
        );
        if (created instanceof Response) return created;
        return json(created);
      }
      return error(405, "method_not_allowed", "method not allowed");
    }

    if (request.method === "GET" && parsed.action === "stats") {
      requirePermission(creator, env, "artifacts:view_stats");
      // total / unique_viewers / last_ts count every row (kept for
      // compatibility). The rest split by kind: people are rows a person's
      // browser wrote; agents are coding agents plus automation. The people
      // facets overlap (a verified pass through a link is both) except
      // self_reported, which is the plain email gate's own word.
      const views = await env.DB.prepare(
        `SELECT COUNT(*) AS total,
           COUNT(DISTINCT email) AS unique_viewers,
           MAX(ts) AS last_ts,
           SUM(CASE WHEN kind = 'human' THEN 1 ELSE 0 END) AS people,
           SUM(CASE WHEN kind = 'human' THEN 0 ELSE 1 END) AS agents,
           COUNT(DISTINCT CASE WHEN kind = 'human' THEN email END) AS unique_people,
           SUM(CASE WHEN kind = 'human' AND verified = 0 AND share_link_id IS NULL
                     AND COALESCE(source, 'gate') <> 'public' THEN 1 ELSE 0 END) AS self_reported,
           SUM(CASE WHEN kind = 'human' AND verified = 1 THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN kind = 'human' AND share_link_id IS NOT NULL THEN 1 ELSE 0 END) AS via_link,
           SUM(CASE WHEN kind = 'human' AND source = 'public' THEN 1 ELSE 0 END) AS public
         FROM views WHERE artifact_id = ?`,
      )
        .bind(artifact.id)
        .first<Record<string, number | null>>();
      const recent = await env.DB.prepare(
        "SELECT email, verified, kind, source, ts, referrer FROM views WHERE artifact_id = ? ORDER BY ts DESC LIMIT 50",
      )
        .bind(artifact.id)
        .all();
      const links = await listShareLinks(env, artifact.id);
      const count = (key: string) => Number(views?.[key] || 0);
      return json({
        artifact,
        views: {
          total: count("total"),
          unique_viewers: count("unique_viewers"),
          last_ts: views?.last_ts ?? null,
          people: count("people"),
          agents: count("agents"),
          unique_people: count("unique_people"),
          self_reported: count("self_reported"),
          verified: count("verified"),
          via_link: count("via_link"),
          public: count("public"),
        },
        recent: recent.results || [],
        links: links.map((link) => shareLinkJson(env, artifact.url_key, link)),
      });
    }

    // Creator-side comments: the publish -> collect feedback -> fix ->
    // republish -> resolve loop, driven by the owner's own bearer token.
    if (parsed.action === "comments") {
      if (request.method === "GET") {
        requirePermission(creator, env, "artifacts:read");
        const q = new URL(request.url).searchParams;
        // A creator identity listing comments is the agent watching: the page
        // shows viewers "an agent checked this page N min ago".
        await touchArtifactWatch(
          env,
          artifact,
          creatorAgentLabel(creator) || "agent",
        );
        const filters = {
          status: q.get("status"),
          since: Number(q.get("since")) || null,
          pagePath: q.get("page_path"),
          limit: Number(q.get("limit")) || null,
        };
        const wait = clampWait(q.get("wait"));
        return json(
          wait
            ? await waitForComments(env, artifact, filters, wait)
            : await listComments(env, artifact, filters),
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
          client_ref?: unknown;
        };
        const identity = creator.email || creator.sub;
        const limited = await commentWriteRateLimit(request, env, identity);
        if (limited) return limited;
        // Publisher-side writes are the agent's: attributed as such, with the
        // token's label where it has one.
        const result = await createComment(
          env,
          artifact,
          creatorCommentAuthor(creator),
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
  // `/artifacts/{ref}/share-links/{id}`: the item under an action.
  sub?: string;
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
  if (segments[1] === "share-links") {
    return {
      ref: assertArtifactRef(segments[0] || ""),
      action: "share-links",
      sub: assertLinkId(segments[2] || ""),
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

function assertLinkId(value: string): string {
  if (!/^[a-z0-9]{8,64}$/i.test(value))
    throw new Error("share link id must be 8-64 alphanumeric characters");
  return value;
}

// Shared by the JSON API (and so the MCP tool) and the admin sheet: validate,
// hash the passcode, insert, and answer with the link object plus the
// passcode — the only time it is ever shown.
export async function createShareLinkFromInput(
  env: Env,
  artifact: Artifact,
  creator: Creator,
  body: {
    kind?: unknown;
    recipient_email?: unknown;
    recipient_label?: unknown;
    label?: unknown;
    passcode?: unknown;
    expires_days?: unknown;
    max_opens?: unknown;
  },
): Promise<Record<string, unknown> | Response> {
  const kind =
    (String(body.kind || "recipient") as ShareLinkKind) || "recipient";
  if (!SHARE_LINK_KINDS.includes(kind))
    return error(
      400,
      "invalid_link_kind",
      "kind must be one of recipient, password, open",
    );
  const recipientEmail = body.recipient_email
    ? normalizeEmail(String(body.recipient_email))
    : null;
  if (recipientEmail && !validEmail(recipientEmail))
    return error(
      400,
      "invalid_email",
      "recipient_email is not a valid address",
    );
  const recipientLabel = trimmed(body.recipient_label, 120);
  const label = trimmed(body.label, 120);
  const expiresDays = numberOrNull(body.expires_days);
  if (expiresDays !== null && !(expiresDays >= 1 && expiresDays <= 365))
    return error(400, "invalid_expiry", "expires_days must be 1-365");
  const expiresAt = expiresDays
    ? nowSec() + Math.floor(expiresDays) * 86400
    : null;
  const maxOpens = numberOrNull(body.max_opens);
  if (maxOpens !== null && !(maxOpens >= 1 && maxOpens <= 100000))
    return error(400, "invalid_max_opens", "max_opens must be 1-100000");
  let passcode: string | null = null;
  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;
  const customPasscode = normalizePasscode(body.passcode);
  if (kind === "password") {
    passcode = customPasscode || generatePasscode();
    if (passcode.length < PASSCODE_MIN || passcode.length > PASSCODE_MAX)
      return error(
        400,
        "invalid_passcode",
        `passcode must be ${PASSCODE_MIN}-${PASSCODE_MAX} characters`,
      );
    passwordSalt = randomSalt();
    passwordHash = await hashPasscode(passcode, passwordSalt);
  } else if (customPasscode) {
    return error(
      400,
      "invalid_passcode",
      "passcode only applies to kind=password",
    );
  }
  const link = await createShareLink(env, artifact, creator, {
    kind,
    label,
    recipientEmail,
    recipientLabel,
    passwordHash,
    passwordSalt,
    expiresAt,
    maxOpens: maxOpens ? Math.floor(maxOpens) : null,
  });
  return {
    ...shareLinkJson(env, artifact.url_key, link),
    ...(passcode ? { passcode } : {}),
    note: passcode
      ? `Share the url and the passcode separately; the passcode is shown only now. ${UNLISTED_NOTE}`
      : UNLISTED_NOTE,
  };
}

function trimmed(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function assertArtifactRef(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(value))
    throw new Error("artifact reference must be lower-case hyphen-case");
  return value;
}
