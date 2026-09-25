import type { Artifact, Creator, Env } from "./types";
import { nowSec, publicArtifactPath } from "./util";
import { enqueueCommentEvent, type CommentEvent } from "./webhooks";

// Shared comment operations behind both comment surfaces: the viewer route
// (/_au/comments — feedback widget + viewer-session agents) and the creator
// route (/api/v1/artifacts/{ref}/comments — owner tokens, MCP, CLI). Both
// speak the same row shape so an agent can switch surfaces without relearning.

export type AuthorKind = "human" | "agent";

export interface CommentAuthor {
  email: string;
  // views row for viewer sessions; null for workspace (creator) identities.
  viewId: number | null;
  // Honest authorship: creator tokens and delegated agent tokens write as
  // `agent` (with the token's label where it has one); everyone else is human.
  kind?: AuthorKind;
  label?: string | null;
  // A creator credential of the publishing workspace (token, OAuth, dev): the
  // publishing agent. Its reads count as "an agent is watching".
  creator?: boolean;
}

export interface CommentFilters {
  status?: string | null; // open | sent | resolved | all (default all)
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
  sent_to_agent_at: number | null;
  author_kind: AuthorKind;
  agent_label: string | null;
  target: unknown;
  target_json: string | null;
}

export interface CommentList {
  comments: ApiComment[];
  count: number;
  has_more: boolean;
  // Pass back as `since` on the next call to see only newer comments. When
  // `has_more` is true it does not advance: re-list with a larger limit first.
  next_since: number;
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
  sent_to_agent_at: number | null;
  author_kind: string | null;
  agent_label: string | null;
}

const ROW_COLUMNS =
  "c.id, c.parent_comment_id, c.email, c.body, c.target_json, c.page_path, c.version_id, c.created_at, c.resolved_at, c.resolved_by, c.sent_to_agent_at, c.author_kind, c.agent_label";

export async function listComments(
  env: Env,
  artifact: Artifact,
  filters: CommentFilters = {},
  now = nowSec(),
): Promise<CommentList> {
  const where: string[] = ["c.artifact_id = ?", "c.deleted_at IS NULL"];
  const binds: unknown[] = [artifact.id];
  // A reply's resolution and sent state are its root's: threads move as a unit.
  const threadResolved =
    "CASE WHEN c.parent_comment_id IS NULL THEN c.resolved_at ELSE root.resolved_at END";
  const threadSent =
    "CASE WHEN c.parent_comment_id IS NULL THEN c.sent_to_agent_at ELSE root.sent_to_agent_at END";
  const status = filters.status === undefined ? null : filters.status;
  if (status === "open") where.push(`${threadResolved} IS NULL`);
  else if (status === "resolved") where.push(`${threadResolved} IS NOT NULL`);
  else if (status === "sent")
    where.push(`${threadResolved} IS NULL`, `${threadSent} IS NOT NULL`);
  const since =
    filters.since && Number.isFinite(filters.since)
      ? Math.floor(filters.since)
      : null;
  if (since !== null) {
    where.push("c.created_at > ?");
    binds.push(since);
  }
  if (filters.pagePath) {
    where.push("c.page_path = ?");
    binds.push(normalizePagePath(env, artifact, filters.pagePath, false));
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
  const hasMore = results.length > limit;
  return {
    comments: page,
    count: page.length,
    has_more: hasMore,
    next_since: nextSince(page, since, hasMore, now),
  };
}

// The cursor for the next `since`. A comment inserted in the same second as
// our query lands with created_at <= now, so the cursor never passes `now - 1`:
// at worst a comment from the boundary second repeats, never goes missing.
function nextSince(
  page: ApiComment[],
  since: number | null,
  hasMore: boolean,
  now: number,
): number {
  if (hasMore) return since ?? 0;
  const newest = page.reduce((max, c) => Math.max(max, c.created_at), 0);
  return Math.min(page.length ? newest : now - 1, now - 1);
}

// ---- long-poll ----
// Holding the request beats polling: one measured unattended run wasted 36
// of 41 one-minute polls. The handler checks D1 every 2s for up to `wait`
// seconds and answers as soon as a comment newer than `since` exists.
export const LONG_POLL_MAX_SEC = 25;
export const LONG_POLL_INTERVAL_MS = 2000;
const SETTLE_MS = 1100;

export function clampWait(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), LONG_POLL_MAX_SEC);
}

export interface WaitOptions {
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

export async function waitForComments(
  env: Env,
  artifact: Artifact,
  filters: CommentFilters,
  waitSec: number,
  opts: WaitOptions = {},
): Promise<CommentList> {
  const sleep = opts.sleep || defaultSleep;
  const nowMs = opts.nowMs || Date.now;
  const now = () => Math.floor(nowMs() / 1000);
  const deadline = nowMs() + clampWait(waitSec) * 1000;
  for (;;) {
    const list = await listComments(env, artifact, filters, now());
    if (list.comments.length) {
      // Comments created in the current second may still be landing; settle
      // once so `next_since` can advance past the whole burst.
      const newest = list.comments.reduce(
        (max, c) => Math.max(max, c.created_at),
        0,
      );
      if (newest < now()) return list;
      await sleep(SETTLE_MS);
      return listComments(env, artifact, filters, now());
    }
    if (nowMs() >= deadline) return list;
    await sleep(Math.min(LONG_POLL_INTERVAL_MS, deadline - nowMs()));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---- agent presence ----
// Viewers asked "if I leave feedback, does it improve in real time?" and had
// no signal. Every creator-side list upserts last_seen_at (throttled) and the
// page shows "an agent checked this page N min ago".
export const WATCH_WRITE_INTERVAL_SEC = 60;
export const WATCH_ACTIVE_SEC = 10 * 60;
const watchWrites = new Map<string, number>();

export interface AgentPresence {
  watching: boolean;
  last_seen_at: number | null;
  label: string | null;
}

export async function touchArtifactWatch(
  env: Env,
  artifact: Artifact,
  label: string | null,
  now = nowSec(),
): Promise<boolean> {
  const last = watchWrites.get(artifact.id);
  if (last !== undefined && now - last < WATCH_WRITE_INTERVAL_SEC) return false;
  watchWrites.set(artifact.id, now);
  try {
    await env.DB.prepare(
      `INSERT INTO artifact_watch (artifact_id, last_seen_at, label) VALUES (?, ?, ?)
       ON CONFLICT(artifact_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at, label = excluded.label
       WHERE excluded.last_seen_at - artifact_watch.last_seen_at >= ${WATCH_WRITE_INTERVAL_SEC}`,
    )
      .bind(artifact.id, now, cleanStr(label, 80) || "agent")
      .run();
  } catch {
    // Presence bookkeeping never fails a read.
    watchWrites.delete(artifact.id);
  }
  return true;
}

// Tests only: the per-isolate write throttle would otherwise bleed between cases.
export function resetArtifactWatchThrottle(): void {
  watchWrites.clear();
}

export async function agentPresence(
  env: Env,
  artifactId: string,
  now = nowSec(),
): Promise<AgentPresence> {
  const none: AgentPresence = {
    watching: false,
    last_seen_at: null,
    label: null,
  };
  try {
    const row = await env.DB.prepare(
      "SELECT last_seen_at, label FROM artifact_watch WHERE artifact_id = ?",
    )
      .bind(artifactId)
      .first<{ last_seen_at: unknown; label: unknown }>();
    const seen = Number(row?.last_seen_at);
    if (!row || !Number.isFinite(seen) || seen <= 0) return none;
    return {
      watching: now - seen <= WATCH_ACTIVE_SEC,
      last_seen_at: seen,
      label: typeof row.label === "string" && row.label ? row.label : null,
    };
  } catch {
    return none;
  }
}

// The label shown for a creator identity: the token's name, else "agent".
export function creatorAgentLabel(creator: Creator): string | null {
  const name = creator.raw.name;
  return typeof name === "string" && name.trim()
    ? name.trim().slice(0, 80)
    : null;
}

export function creatorCommentAuthor(creator: Creator): CommentAuthor {
  return {
    email: creator.email || creator.sub,
    viewId: null,
    kind: "agent",
    label: creatorAgentLabel(creator),
    creator: true,
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
    client_ref?: unknown;
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
  const clientRef = cleanStr(input.client_ref, 64) || null;
  const kind: AuthorKind = author.kind === "agent" ? "agent" : "human";
  const label = kind === "agent" ? cleanStr(author.label, 80) : null;
  const createdAt = nowSec();
  let inserted;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO comments
     (artifact_id, view_id, email, body, target_json, page_path, version_id, parent_comment_id, client_ref, created_at, author_kind, agent_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        clientRef,
        createdAt,
        kind,
        label,
      )
      .run();
  } catch (e) {
    // A retry after a lost response trips the (artifact_id, client_ref)
    // unique index; return the already-created comment instead.
    if (clientRef && String(e).includes("UNIQUE")) {
      const existing = await commentByClientRef(env, artifact.id, clientRef);
      if (existing) return { ok: true, comment: apiComment(existing) };
    }
    throw e;
  }
  const comment = apiComment({
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
    sent_to_agent_at: null,
    author_kind: kind,
    agent_label: label,
  });
  await emitCommentEvent(
    env,
    artifact,
    parent ? "comment.replied" : "comment.created",
    comment,
    parent?.id ?? null,
  );
  return { ok: true, comment };
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
  const row = await commentById(env, artifact.id, id);
  if (row) {
    const comment = apiComment({
      ...row,
      resolved_at: resolvedAt,
      resolved_by: resolvedBy,
    });
    await emitCommentEvent(
      env,
      artifact,
      resolved ? "comment.resolved" : "comment.reopened",
      comment,
      row.parent_comment_id,
    );
  }
  return { id, resolved, resolved_at: resolvedAt, resolved_by: resolvedBy };
}

// "Send to agent": the viewer flags a thread for the publishing agent. The
// flag lives on the root; a reply id is resolved to its root.
export async function markSentToAgent(
  env: Env,
  artifact: Artifact,
  id: number,
  sent: boolean,
): Promise<{ id: number; sent_to_agent_at: number | null } | null> {
  const row = await commentById(env, artifact.id, id);
  if (!row) return null;
  const rootId = row.parent_comment_id || row.id;
  const root =
    rootId === row.id ? row : await commentById(env, artifact.id, rootId);
  if (!root) return null;
  const sentAt = sent ? nowSec() : null;
  await env.DB.prepare(
    "UPDATE comments SET sent_to_agent_at = ? WHERE id = ? AND artifact_id = ?",
  )
    .bind(sentAt, rootId, artifact.id)
    .run();
  if (sent) {
    const comment = apiComment({ ...root, sent_to_agent_at: sentAt });
    await emitCommentEvent(
      env,
      artifact,
      "comment.sent_to_agent",
      comment,
      null,
    );
  }
  return { id: rootId, sent_to_agent_at: sentAt };
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

// Webhook fan-out. `rootId` names the thread root when the comment is a
// reply; the payload carries both. Delivery never fails the write.
async function emitCommentEvent(
  env: Env,
  artifact: Artifact,
  event: CommentEvent,
  comment: ApiComment,
  rootId: number | null,
): Promise<void> {
  try {
    const root =
      rootId && rootId !== comment.id
        ? await commentById(env, artifact.id, rootId)
        : null;
    await enqueueCommentEvent(
      env,
      artifact,
      event,
      comment,
      root ? apiComment(root) : comment,
    );
  } catch {
    // Webhooks are best-effort; the comment is already written.
  }
}

async function commentByClientRef(
  env: Env,
  artifactId: string,
  clientRef: string,
): Promise<CommentRow | null> {
  return await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM comments c
     WHERE c.artifact_id = ? AND c.client_ref = ? AND c.deleted_at IS NULL`,
  )
    .bind(artifactId, clientRef)
    .first<CommentRow>();
}

async function commentById(
  env: Env,
  artifactId: string,
  id: number,
): Promise<CommentRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM comments c
     WHERE c.id = ? AND c.artifact_id = ? AND c.deleted_at IS NULL`,
  )
    .bind(id, artifactId)
    .first<CommentRow>();
  return row && Number.isFinite(Number(row.id)) ? row : null;
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
    sent_to_agent_at: row.sent_to_agent_at ?? null,
    author_kind: row.author_kind === "agent" ? "agent" : "human",
    agent_label: row.agent_label || null,
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

// Target v3. v2 fields keep their meaning (selector, label, path, version_id,
// text, anchors, rect); v3 adds the element context that turns a bare "div"
// on an image grid into "image: hero-loop-v2.mp4 under 'Option B'".
interface CleanTarget {
  v: number;
  selector: string;
  label: string;
  path: string;
  version_id?: string;
  text?: string;
  anchors?: { type: string; value: string; name?: string }[];
  rect: { x: number; y: number; w: number; h: number } | null;
  tag?: string;
  caption?: string;
  src?: string;
  heading?: string;
  page_title?: string;
  index?: number;
  viewport?: { w: number; h: number; dpr: number };
}

export const TARGET_JSON_MAX = 3000;
// Dropped in this order when the JSON would exceed TARGET_JSON_MAX.
const TARGET_OPTIONAL_ORDER: (keyof CleanTarget)[] = [
  "anchors",
  "page_title",
  "text",
  "caption",
  "heading",
];

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
    v: 3,
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
  const tag = cleanStr(input.tag, 32);
  if (tag) clean.tag = tag.toLowerCase();
  const caption = cleanStr(input.caption, 200);
  if (caption) clean.caption = caption;
  const src = cleanStr(input.src, 160);
  if (src) clean.src = src;
  const heading = cleanStr(input.heading, 160);
  if (heading) clean.heading = heading;
  const pageTitle = cleanStr(input.page_title, 160);
  if (pageTitle) clean.page_title = pageTitle;
  const index = positiveInteger(input.index);
  if (index) clean.index = index;
  const viewport = input.viewport as Record<string, unknown> | undefined;
  if (viewport && typeof viewport === "object")
    clean.viewport = {
      w: finiteNumber(viewport.w),
      h: finiteNumber(viewport.h),
      dpr: Math.round(Number(viewport.dpr) * 100) / 100 || 1,
    };
  let json = JSON.stringify(clean);
  for (const key of TARGET_OPTIONAL_ORDER) {
    if (json.length <= TARGET_JSON_MAX) break;
    delete clean[key];
    json = JSON.stringify(clean);
  }
  return json;
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

// One key per page: no trailing `index.html`, no trailing slash. `/go/x/`,
// `/go/x/index.html` and `/go/x` all become `/go/x`.
export function canonicalPagePath(path: string): string {
  return String(path || "")
    .replace(/\/index\.html?$/i, "/")
    .replace(/\/+$/, "");
}

// Clamp a comment's page_path to a path within the artifact. A stray value
// (absent, "/", or another origin — e.g. from an agent that guessed it) becomes
// the artifact's root, so the widget never navigates off the artifact. With
// `clamp` off (read filters) a foreign path is kept and simply matches nothing.
export function normalizePagePath(
  env: Env,
  artifact: Artifact,
  raw: string | null,
  clamp = true,
): string {
  const base = publicArtifactPath(env, artifact.url_key);
  const root = base.replace(/\/+$/, "");
  if (!raw) return root;
  let p = raw;
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* keep p */
  }
  if (p === root || p.startsWith(base))
    return canonicalPagePath(p).slice(0, 300) || root;
  return clamp ? root : p.slice(0, 300);
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
