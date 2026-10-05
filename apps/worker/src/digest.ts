// Daily feedback digest: one email to the operator with what reviewers said
// across the configured workspaces in the last day, and which recent threads
// are still waiting for a first reply. Configured by vars, off by default:
//   FEEDBACK_DIGEST_TO    comma-separated recipients
//   FEEDBACK_DIGEST_ORGS  comma-separated workspace (org) ids to cover
//   FEEDBACK_DIGEST_CRON  the [triggers] cron that sends it (DEFAULT_DIGEST_CRON)
// Comment text is reviewer-written and untrusted: it is escaped, excerpted and
// never turned into a link.
import type { Env } from "./types";
import { sendSystemEmail } from "./mailer";
import { clearRateLimit, rateLimit } from "./rl";
import { escapeHtml, nowSec, publicArtifactUrl, siteBaseUrl } from "./util";

export const DEFAULT_DIGEST_CRON = "0 14 * * *";
export const DIGEST_WINDOW_SEC = 24 * 60 * 60;
// Older unanswered threads are counted, not listed: production has months of
// them, and a daily list of June threads would bury today's.
export const WAITING_WINDOW_SEC = 14 * 24 * 60 * 60;
const MAX_NEW = 200;
const MAX_WAITING = 30;
const EXCERPT_CHARS = 300;
const SLOT_BUCKET = "digest:feedback:daily";

// Feedback is what people, and reviewers' delegated agents, wrote. Replies by
// the publishing side's own agents are activity, not feedback.
// COALESCE keeps the test two-valued: a NULL label must read as "ours", not
// as unknown, or NOT IS_FEEDBACK would skip every agent reply.
const IS_FEEDBACK =
  "(c.author_kind = 'human' OR COALESCE(c.agent_label, '') = 'delegated')";

export interface DigestConfig {
  to: string[];
  orgIds: string[];
}

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function digestConfig(env: Env): DigestConfig | null {
  const to = csv(env.FEEDBACK_DIGEST_TO);
  const orgIds = csv(env.FEEDBACK_DIGEST_ORGS);
  return to.length && orgIds.length ? { to, orgIds } : null;
}

export function isDigestCron(env: Env, cron: string): boolean {
  return cron === (env.FEEDBACK_DIGEST_CRON || DEFAULT_DIGEST_CRON);
}

export interface DigestItem {
  id: number;
  author: string;
  reply: boolean;
  excerpt: string;
  // The commented page relative to the artifact ("clinician.html"), and its
  // URL; null for the entry page.
  pagePath: string | null;
  pageUrl: string | null;
  createdAt: number;
  // For thread roots: resolved, answered (has a reply) or waiting.
  status: "resolved" | "answered" | "waiting" | "reply";
}

export interface DigestArtifact {
  id: string;
  title: string;
  url: string;
  adminUrl: string;
  items: DigestItem[];
}

export interface FeedbackDigest {
  since: number;
  until: number;
  artifacts: DigestArtifact[];
  newCount: number;
  people: number;
  agentReplies: number;
  resolved: number;
  // Threads from before the window, still with no reply at all.
  waiting: DigestArtifact[];
  waitingTotal: number;
  olderWaiting: number;
}

interface CommentRow {
  id: number;
  artifact_id: string;
  parent_comment_id: number | null;
  email: string;
  body: string;
  page_path: string | null;
  created_at: number;
  resolved_at: number | null;
  author_kind: string;
  agent_label: string | null;
  title: string;
  url_key: string;
  replies: number;
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS
    ? `${flat.slice(0, EXCERPT_CHARS - 1)}…`
    : flat;
}

function author(row: CommentRow): string {
  return row.agent_label === "delegated" ? `${row.email}'s agent` : row.email;
}

// page_path is stored as the full public path ("/go/<key>/clinician.html").
function page(
  env: Env,
  row: CommentRow,
): { pagePath: string | null; pageUrl: string | null } {
  const base = publicArtifactUrl(env, row.url_key);
  const prefix = new URL(base).pathname;
  const raw = row.page_path || "";
  // The artifact root arrives both with and without its trailing slash.
  const rel =
    raw === prefix.replace(/\/$/, "")
      ? ""
      : raw.startsWith(prefix)
        ? raw.slice(prefix.length)
        : raw.replace(/^\/+/, "");
  return !rel || rel === "index.html"
    ? { pagePath: null, pageUrl: null }
    : { pagePath: rel, pageUrl: `${base}${rel}` };
}

function item(env: Env, row: CommentRow): DigestItem {
  return {
    id: Number(row.id),
    author: author(row),
    reply: row.parent_comment_id !== null,
    excerpt: excerpt(row.body),
    ...page(env, row),
    createdAt: Number(row.created_at),
    status:
      row.parent_comment_id !== null
        ? "reply"
        : row.resolved_at
          ? "resolved"
          : Number(row.replies) > 0
            ? "answered"
            : "waiting",
  };
}

// Rows grouped under their artifact, in the order each artifact first appears.
function groupByArtifact(env: Env, rows: CommentRow[]): DigestArtifact[] {
  const groups = new Map<string, DigestArtifact>();
  for (const row of rows) {
    let group = groups.get(row.artifact_id);
    if (!group) {
      group = {
        id: row.artifact_id,
        title: row.title,
        url: publicArtifactUrl(env, row.url_key),
        adminUrl: `${siteBaseUrl(env)}/admin?open=${encodeURIComponent(row.artifact_id)}`,
        items: [],
      };
      groups.set(row.artifact_id, group);
    }
    group.items.push(item(env, row));
  }
  return [...groups.values()];
}

export async function buildFeedbackDigest(
  env: Env,
  config: DigestConfig,
  now = nowSec(),
): Promise<FeedbackDigest> {
  const since = now - DIGEST_WINDOW_SEC;
  const waitingSince = now - WAITING_WINDOW_SEC;
  const orgs = config.orgIds.map(() => "?").join(", ");
  const scope = `a.org_id IN (${orgs}) AND a.status = 'active' AND c.deleted_at IS NULL`;
  const replyCount =
    "(SELECT COUNT(*) FROM comments x WHERE x.parent_comment_id = c.id AND x.deleted_at IS NULL)";

  const fresh = await env.DB.prepare(
    `SELECT c.id, c.artifact_id, c.parent_comment_id, c.email, c.body,
            c.page_path, c.created_at, c.resolved_at, c.author_kind,
            c.agent_label, a.title, a.url_key, ${replyCount} AS replies
     FROM comments c JOIN artifacts a ON a.id = c.artifact_id
     WHERE ${scope} AND ${IS_FEEDBACK}
       AND c.created_at >= ? AND c.created_at < ?
     ORDER BY c.created_at
     LIMIT ?`,
  )
    .bind(...config.orgIds, since, now, MAX_NEW)
    .all<CommentRow>();

  const activity = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN NOT ${IS_FEEDBACK} AND c.created_at >= ? THEN 1 ELSE 0 END) AS agent_replies,
       SUM(CASE WHEN c.parent_comment_id IS NULL AND c.resolved_at >= ? THEN 1 ELSE 0 END) AS resolved
     FROM comments c JOIN artifacts a ON a.id = c.artifact_id
     WHERE ${scope} AND (c.created_at >= ? OR c.resolved_at >= ?)`,
  )
    .bind(since, since, ...config.orgIds, since, since)
    .first<{ agent_replies: number | null; resolved: number | null }>();

  const unanswered = `${scope} AND ${IS_FEEDBACK}
       AND c.parent_comment_id IS NULL AND c.resolved_at IS NULL
       AND ${replyCount} = 0`;
  const waiting = await env.DB.prepare(
    `SELECT c.id, c.artifact_id, c.parent_comment_id, c.email, c.body,
            c.page_path, c.created_at, c.resolved_at, c.author_kind,
            c.agent_label, a.title, a.url_key, 0 AS replies
     FROM comments c JOIN artifacts a ON a.id = c.artifact_id
     WHERE ${unanswered} AND c.created_at >= ? AND c.created_at < ?
     ORDER BY c.created_at
     LIMIT ?`,
  )
    .bind(...config.orgIds, waitingSince, since, MAX_WAITING)
    .all<CommentRow>();
  const waitingCounts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN c.created_at >= ? AND c.created_at < ? THEN 1 ELSE 0 END) AS recent,
       SUM(CASE WHEN c.created_at < ? THEN 1 ELSE 0 END) AS older
     FROM comments c JOIN artifacts a ON a.id = c.artifact_id
     WHERE ${unanswered}`,
  )
    .bind(waitingSince, since, waitingSince, ...config.orgIds)
    .first<{ recent: number | null; older: number | null }>();

  // A delegated agent speaks for the reviewer whose email it carries.
  const people = new Set(
    (fresh.results || []).map((row) => row.email.toLowerCase()),
  );

  return {
    since,
    until: now,
    // Busiest artifact first; ties by title so the order is stable.
    artifacts: groupByArtifact(env, fresh.results || []).sort(
      (a, b) =>
        b.items.length - a.items.length || a.title.localeCompare(b.title),
    ),
    newCount: (fresh.results || []).length,
    people: people.size,
    agentReplies: Number(activity?.agent_replies || 0),
    resolved: Number(activity?.resolved || 0),
    // Oldest thread first, so the longest wait leads.
    waiting: groupByArtifact(env, waiting.results || []),
    waitingTotal: Number(waitingCounts?.recent || 0),
    olderWaiting: Number(waitingCounts?.older || 0),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ago(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 2 * 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

export function digestSubject(digest: FeedbackDigest): string {
  const parts = [
    digest.newCount
      ? `${plural(digest.newCount, "new comment")} on ${plural(digest.artifacts.length, "artifact")}`
      : "no new comments",
  ];
  if (digest.waitingTotal)
    parts.push(`${digest.waitingTotal} waiting for a reply`);
  return `Artifact feedback: ${parts.join(" · ")}`;
}

function headline(digest: FeedbackDigest): string {
  const lines = [
    digest.newCount
      ? `Last 24 hours: ${plural(digest.newCount, "new comment")} on ${plural(digest.artifacts.length, "artifact")} from ${plural(digest.people, "person", "people")}.`
      : "No new comments in the last 24 hours.",
  ];
  const activity = [
    digest.agentReplies
      ? plural(digest.agentReplies, "agent reply", "agent replies")
      : null,
    digest.resolved ? `${plural(digest.resolved, "thread")} resolved` : null,
  ].filter(Boolean);
  if (activity.length) lines.push(`Also: ${activity.join(", ")}.`);
  if (digest.waitingTotal)
    lines.push(
      `${plural(digest.waitingTotal, "thread")} from the previous 14 days still ${digest.waitingTotal === 1 ? "has" : "have"} no reply.`,
    );
  return lines.join(" ");
}

const STATUS_LABEL: Record<DigestItem["status"], string> = {
  resolved: "resolved",
  answered: "answered",
  waiting: "no reply yet",
  reply: "reply",
};

export function renderFeedbackDigest(digest: FeedbackDigest): {
  subject: string;
  text: string;
  html: string;
} {
  const now = digest.until;
  const text: string[] = [headline(digest), ""];
  const html: string[] = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#1b2429;max-width:680px">`,
    `<p style="font-size:15px;line-height:1.5">${escapeHtml(headline(digest))}</p>`,
  ];

  const itemText = (i: DigestItem) =>
    `- ${i.author} · ${ago(now - i.createdAt)}${i.pageUrl ? ` · ${i.pageUrl}` : ""} · ${STATUS_LABEL[i.status]}\n  "${i.excerpt}"`;
  const itemHtml = (i: DigestItem) =>
    `<div style="margin:10px 0;padding:8px 12px;border-left:3px solid ${i.status === "waiting" ? "#c2410c" : "#cbd5d1"};background:#f6f8f8">` +
    `<div style="font-size:12px;color:#5c6b66">${escapeHtml(i.author)} · ${escapeHtml(ago(now - i.createdAt))}${i.pagePath && i.pageUrl ? ` · <a href="${escapeHtml(i.pageUrl)}" style="color:#5c6b66">${escapeHtml(i.pagePath)}</a>` : ""} · <strong style="white-space:nowrap">${escapeHtml(STATUS_LABEL[i.status])}</strong></div>` +
    `<div style="font-size:14px;line-height:1.45;margin-top:4px;white-space:pre-wrap">${escapeHtml(i.excerpt)}</div></div>`;

  const section = (heading: string, groups: DigestArtifact[]) => {
    text.push(heading.toUpperCase(), "");
    html.push(`<h2 style="font-size:16px;margin:24px 0 8px">${heading}</h2>`);
    for (const artifact of groups) {
      const count = plural(artifact.items.length, "comment");
      text.push(
        `${artifact.title} (${count})`,
        `  ${artifact.url}`,
        ...artifact.items.map(itemText),
        "",
      );
      html.push(
        `<h3 style="font-size:15px;margin:18px 0 0"><a href="${escapeHtml(artifact.url)}" style="color:#0c585b">${escapeHtml(artifact.title)}</a></h3>`,
        `<div style="font-size:13px;color:#5c6b66;margin:2px 0 6px">${escapeHtml(count)} · <a href="${escapeHtml(artifact.adminUrl)}" style="color:#0c585b">open in admin</a></div>`,
        ...artifact.items.map(itemHtml),
      );
    }
  };
  if (digest.artifacts.length) section("New feedback", digest.artifacts);
  if (digest.waiting.length) {
    section("Still waiting for a first reply", digest.waiting);
    const listed = digest.waiting.reduce((n, a) => n + a.items.length, 0);
    if (digest.waitingTotal > listed) {
      const more = `…and ${digest.waitingTotal - listed} more.`;
      text.push(more, "");
      html.push(`<p style="font-size:13px;color:#5c6b66">${more}</p>`);
    }
  }

  const footer = `${digest.olderWaiting ? `${plural(digest.olderWaiting, "older thread")} (over 14 days) never got a reply. ` : ""}Reply from the comments panel on each page, or ask your agent to work through them.`;
  text.push(footer);
  html.push(
    `<p style="font-size:12px;color:#5c6b66;margin-top:28px">${escapeHtml(footer)}</p></div>`,
  );
  return {
    subject: digestSubject(digest),
    text: text.join("\n"),
    // A whole document, so phone mail clients get a viewport and don't shrink it.
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px;background:#ffffff">${html.join("\n")}</body></html>`,
  };
}

export type DigestResult =
  | { sent: true; to: string[]; subject: string; newCount: number }
  | {
      sent: false;
      reason:
        | "not_configured"
        | "already_sent_today"
        | "nothing_to_report"
        | "delivery_failed";
    };

// At most one digest per UTC day, whatever the cron does; a failed delivery
// gives the slot back so a retry the same day can still send.
export async function sendFeedbackDigest(
  env: Env,
  now = nowSec(),
): Promise<DigestResult> {
  const config = digestConfig(env);
  if (!config) return { sent: false, reason: "not_configured" };
  const slot = await rateLimit(env, SLOT_BUCKET, 1, 86400, now);
  if (!slot.allowed) return { sent: false, reason: "already_sent_today" };
  const digest = await buildFeedbackDigest(env, config, now);
  if (!digest.newCount && !digest.waitingTotal)
    return { sent: false, reason: "nothing_to_report" };
  const email = renderFeedbackDigest(digest);
  try {
    for (const to of config.to) await sendSystemEmail(env, to, email);
  } catch {
    await clearRateLimit(env, SLOT_BUCKET, 86400, now);
    return { sent: false, reason: "delivery_failed" };
  }
  return {
    sent: true,
    to: config.to,
    subject: email.subject,
    newCount: digest.newCount,
  };
}
