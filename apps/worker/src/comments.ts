import type { Artifact, Env } from "./types";
import { nowSec, publicArtifactPath } from "./util";

// Shared comment operations behind both comment surfaces: the viewer route
// (/_au/comments — feedback widget + viewer-session agents) and the creator
// route (/api/v1/artifacts/{ref}/comments — owner tokens, MCP, CLI). Both
// speak the same row shape so an agent can switch surfaces without relearning.

export interface CommentAuthor {
  email: string;
  // views row for viewer sessions; null for workspace (creator) identities.
  viewId: number | null;
}

export interface CommentFilters {
  status?: string | null; // open | resolved | all (default all)
  since?: number | null; // created_at strictly after this unix timestamp
  pagePath?: string | null;
  limit?: number | null; // default 200, max 500
}

// Raw row plus agent conveniences: `resolved` as a boolean and `target` as a
// parsed object. `target_json` stays (the feedback widget consumes it).
export interface ApiComment {
  id: number;
  parent_comment_id: number | null;
  email: string;
  body: string;
  page_path: string | null;
  version_id: string | null;
  created_at: number;
  resolved: boolean;
  resolved_at: number | null;
  resolved_by: string | null;
  target: unknown;
  target_json: string | null;
}

export interface CommentList {
  comments: ApiComment[];
  count: number;
  has_more: boolean;
}

export type CommentWriteResult =
  | { ok: true; comment: ApiComment }
  | { ok: false; status: number; code: string; message: string };

interface CommentRow {
  id: number;
  parent_comment_id: number | null;
  email: string;
  body: string;
  target_json: string | null;
  page_path: string | null;
  version_id: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

const ROW_COLUMNS =
  "c.id, c.parent_comment_id, c.email, c.body, c.target_json, c.page_path, c.version_id, c.created_at, c.resolved_at, c.resolved_by";

export async function listComments(
  env: Env,
  artifact: Artifact,
  filters: CommentFilters = {},
): Promise<CommentList> {
  const where: string[] = ["c.artifact_id = ?", "c.deleted_at IS NULL"];
  const binds: unknown[] = [artifact.id];
  // A reply's resolution state is its root's: threads resolve as a unit.
  const threadResolved =
    "CASE WHEN c.parent_comment_id IS NULL THEN c.resolved_at ELSE root.resolved_at END";
  const status = filters.status === undefined ? null : filters.status;
  if (status === "open") where.push(`${threadResolved} IS NULL`);
  else if (status === "resolved") where.push(`${threadResolved} IS NOT NULL`);
  if (filters.since && Number.isFinite(filters.since)) {
    where.push("c.created_at > ?");
    binds.push(Math.floor(filters.since));
  }
  if (filters.pagePath) {
    where.push("c.page_path = ?");
    binds.push(filters.pagePath.slice(0, 300));
  }
  const limit = clampLimit(filters.limit);
  const rows = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM comments c
     LEFT JOIN comments root ON root.id = c.parent_comment_id
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(c.parent_comment_id, c.id) DESC,
       CASE WHEN c.parent_comment_id IS NULL THEN 0 ELSE 1 END,
       c.created_at ASC
     LIMIT ${limit + 1}`,
  )
    .bind(...binds)
    .all<CommentRow>();
  const results = rows.results || [];
  const page = results.slice(0, limit).map(apiComment);
  return {
    comments: page,
    count: page.length,
    has_more: results.length > limit,
  };
}

export async function createComment(
  env: Env,
  artifact: Artifact,
  author: CommentAuthor,
  input: {
    body?: unknown;
    parent_id?: unknown;
    target?: unknown;
    page_path?: unknown;
    version_id?: unknown;
  },
): Promise<CommentWriteResult> {
  const text = String(input.body || "")
    .trim()
    .slice(0, 2000);
  if (!text)
    return {
      ok: false,
      status: 400,
      code: "body_required",
      message: "comment body required",
    };
  const parentId = positiveInteger(input.parent_id);
  const parent = parentId
    ? await commentParent(env, artifact.id, parentId)
    : null;
  if (parentId && !parent)
    return {
      ok: false,
      status: 404,
      code: "comment_not_found",
      message: "parent comment not found",
    };
  const targetJson =
    commentTargetJson(input.target) || parent?.target_json || null;
  const pagePath = normalizePagePath(
    env,
    artifact,
    cleanStr(input.page_path, 300) || targetPath(targetJson),
  );
  const versionId =
    cleanStr(input.version_id, 64) || artifact.current_version_id || null;
  const createdAt = nowSec();
  const inserted = await env.DB.prepare(
    `INSERT INTO comments
     (artifact_id, view_id, email, body, target_json, page_path, version_id, parent_comment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      artifact.id,
      author.viewId,
      author.email,
      text,
      targetJson,
      pagePath,
      versionId,
      parent?.id || null,
      createdAt,
    )
    .run();
  return {
    ok: true,
    comment: apiComment({
      id: Number(inserted.meta.last_row_id),
      parent_comment_id: parent?.id || null,
      email: author.email,
      body: text,
      target_json: targetJson,
      page_path: pagePath,
      version_id: versionId,
      created_at: createdAt,
      resolved_at: null,
      resolved_by: null,
    }),
  };
}

export async function resolveComment(
  env: Env,
  artifact: Artifact,
  id: number,
  resolved: boolean,
  byEmail: string,
): Promise<{
  id: number;
  resolved: boolean;
  resolved_at: number | null;
  resolved_by: string | null;
} | null> {
  if (!(await commentExists(env, artifact.id, id))) return null;
  const resolvedAt = resolved ? nowSec() : null;
  const resolvedBy = resolved ? byEmail : null;
  await env.DB.prepare(
    "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ? AND artifact_id = ?",
  )
    .bind(resolvedAt, resolvedBy, id, artifact.id)
    .run();
  return { id, resolved, resolved_at: resolvedAt, resolved_by: resolvedBy };
}

// Re-anchor: replace the comment's target with a freshly picked element.
export async function reanchorComment(
  env: Env,
  artifact: Artifact,
  id: number,
  target: unknown,
): Promise<{ id: number; target_json: string } | "invalid_target" | null> {
  if (!(await commentExists(env, artifact.id, id))) return null;
  const targetJson = commentTargetJson(target);
  if (!targetJson) return "invalid_target";
  const pagePath = normalizePagePath(env, artifact, targetPath(targetJson));
  await env.DB.prepare(
    "UPDATE comments SET target_json = ?, page_path = ? WHERE id = ? AND artifact_id = ?",
  )
    .bind(targetJson, pagePath, id, artifact.id)
    .run();
  return { id, target_json: targetJson };
}

async function commentExists(
  env: Env,
  artifactId: string,
  id: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM comments WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL",
  )
    .bind(id, artifactId)
    .first<{ id: number }>();
  return !!row;
}

function apiComment(row: CommentRow): ApiComment {
  return {
    id: row.id,
    parent_comment_id: row.parent_comment_id,
    email: row.email,
    body: row.body,
    page_path: row.page_path,
    version_id: row.version_id,
    created_at: row.created_at,
    resolved: !!row.resolved_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    target: parseTarget(row.target_json),
    target_json: row.target_json,
  };
}

function parseTarget(targetJson: string | null): unknown {
  if (!targetJson) return null;
  try {
    return JSON.parse(targetJson);
  } catch {
    return null;
  }
}

function clampLimit(value: number | null | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 500);
}

async function commentParent(
  env: Env,
  artifactId: string,
  parentId: number,
): Promise<{ id: number; target_json: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT id, parent_comment_id, target_json
     FROM comments
     WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
  )
    .bind(parentId, artifactId)
    .first<{
      id: number;
      parent_comment_id: number | null;
      target_json: string | null;
    }>();
  if (!row) return null;
  if (!row.parent_comment_id)
    return { id: row.id, target_json: row.target_json };
  const root = await env.DB.prepare(
    `SELECT id, target_json
     FROM comments
     WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
  )
    .bind(row.parent_comment_id, artifactId)
    .first<{ id: number; target_json: string | null }>();
  if (!root) return null;
  return { id: root.id, target_json: row.target_json || root.target_json };
}

export function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface CleanTarget {
  v: number;
  selector: string;
  label: string;
  path: string;
  version_id?: string;
  text?: string;
  anchors?: { type: string; value: string; name?: string }[];
  rect: { x: number; y: number; w: number; h: number } | null;
}

function commentTargetJson(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const input = target as Record<string, unknown>;
  const rect = input.rect as Record<string, unknown> | undefined;
  const anchorsIn = Array.isArray(input.anchors) ? input.anchors : [];
  const anchors = anchorsIn
    .slice(0, 6)
    .map((a) => {
      const o = (a || {}) as Record<string, unknown>;
      const out: { type: string; value: string; name?: string } = {
        type: String(o.type || "").slice(0, 16),
        value: String(o.value || "").slice(0, 300),
      };
      if (o.name) out.name = String(o.name).slice(0, 160);
      return out;
    })
    .filter((a) => a.type && a.value);
  const clean: CleanTarget = {
    v: 2,
    selector: String(input.selector || "").slice(0, 300),
    label: String(input.label || "").slice(0, 160),
    path: String(input.path || "").slice(0, 300),
    rect: rect
      ? {
          x: finiteNumber(rect.x),
          y: finiteNumber(rect.y),
          w: finiteNumber(rect.w),
          h: finiteNumber(rect.h),
        }
      : null,
  };
  if (input.version_id)
    clean.version_id = String(input.version_id).slice(0, 64);
  if (input.text) clean.text = String(input.text).slice(0, 200);
  if (anchors.length) clean.anchors = anchors;
  return JSON.stringify(clean).slice(0, 2000);
}

function targetPath(targetJson: string | null): string | null {
  if (!targetJson) return null;
  try {
    const p = (JSON.parse(targetJson) as { path?: unknown }).path;
    return p ? String(p).slice(0, 300) : null;
  } catch {
    return null;
  }
}

function cleanStr(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).slice(0, max);
  return s || null;
}

// Clamp a comment's page_path to a path within the artifact. A stray value
// (absent, "/", or another origin — e.g. from an agent that guessed it) becomes
// the artifact's base path, so the widget never navigates off the artifact.
function normalizePagePath(
  env: Env,
  artifact: Artifact,
  raw: string | null,
): string {
  const base = publicArtifactPath(env, artifact.url_key);
  if (!raw) return base;
  let p = raw;
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* keep p */
  }
  return p.startsWith(base) ? p.slice(0, 300) : base;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
