// Push delivery for the comment loop. A workspace subscribes an HTTPS URL to
// comment events, per artifact or for every artifact; each event becomes a
// signed JSON POST. The first attempt runs right after the write (in the
// background where the runtime offers waitUntil, otherwise inline with a
// short timeout); the six-hourly cron retries with backoff.
import type { Artifact, Env } from "./types";
import type { ApiComment } from "./comments";
import { requirePermission, safeCreator } from "./auth";
import { getArtifactByUrlKey, getArtifactForOrg } from "./db";
import {
  error,
  json,
  nowSec,
  publicArtifactUrl,
  randomId,
  siteBaseUrl,
} from "./util";

export const WEBHOOK_EVENTS = [
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "comment.reopened",
  "comment.sent_to_agent",
] as const;
export type CommentEvent = (typeof WEBHOOK_EVENTS)[number];

// Retry delays after a failed attempt: 1m, 5m, 30m, 2h, 12h; then give up.
export const RETRY_BACKOFF_SEC = [60, 300, 1800, 7200, 43200];
export const MAX_ATTEMPTS = RETRY_BACKOFF_SEC.length + 1;
export const DELIVERY_TIMEOUT_MS = 10_000;
// Inline first attempt (no background context): keep the comment POST snappy.
export const INLINE_DELIVERY_TIMEOUT_MS = 4_000;
export const SIGNATURE_HEADER = "X-Artifact-Use-Signature";
export const EVENT_HEADER = "X-Artifact-Use-Event";
export const DELIVERY_HEADER = "X-Artifact-Use-Delivery";
const MAX_ACTIVE_WEBHOOKS = 20;
const MAX_URL_LENGTH = 512;

export interface WebhookRow {
  id: string;
  org_id: string;
  artifact_id: string | null;
  url: string;
  secret: string;
  events_json: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  last_delivery_at: number | null;
  last_status: number | null;
}

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: number | null;
  delivered_at: number | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
}

export interface WebhookPayload {
  event: CommentEvent;
  artifact: { id: string; url_key: string; url: string; title: string };
  comment: ApiComment;
  thread: ApiComment;
  occurred_at: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeliveryOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempts: number;
  next_attempt_at: number | null;
}

// Validate a subscriber-supplied URL the way upstream.ts validates backends:
// public HTTPS hosts only — no credentials or fragment, no IP literals,
// loopback or link-local names, never the artifact host itself. A query string
// is allowed (receivers commonly key on one).
export function normalizeWebhookUrl(value: string, env: Env): string | null {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith("[") || /^[0-9.]+$/.test(host)) return null;
  if (!host.includes(".")) return null;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa")
  )
    return null;
  try {
    if (host === new URL(siteBaseUrl(env)).hostname.toLowerCase()) return null;
  } catch {
    // no site host to compare against
  }
  return url.toString();
}

export function normalizeEvents(value: unknown): CommentEvent[] | null {
  if (value === undefined || value === null) return [...WEBHOOK_EVENTS];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out: CommentEvent[] = [];
  for (const item of list) {
    const name = String(item || "").trim() as CommentEvent;
    if (!name) continue;
    if (!WEBHOOK_EVENTS.includes(name)) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out.length ? out : [...WEBHOOK_EVENTS];
}

export async function signWebhookBody(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function webhookPayload(
  env: Env,
  artifact: Artifact,
  event: CommentEvent,
  comment: ApiComment,
  thread: ApiComment,
  now = nowSec(),
): WebhookPayload {
  return {
    event,
    artifact: {
      id: artifact.id,
      url_key: artifact.url_key,
      url: publicArtifactUrl(env, artifact.url_key),
      title: artifact.title,
    },
    comment,
    thread,
    occurred_at: now,
  };
}

// Active subscriptions for one event on one artifact.
async function subscribersFor(
  env: Env,
  orgId: string,
  artifactId: string,
  event: CommentEvent,
): Promise<WebhookRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM artifact_webhooks
     WHERE org_id = ? AND revoked_at IS NULL
       AND (artifact_id IS NULL OR artifact_id = ?)
     ORDER BY created_at LIMIT ?`,
  )
    .bind(orgId, artifactId, MAX_ACTIVE_WEBHOOKS)
    .all<WebhookRow>();
  return (rows.results || []).filter((row) => {
    try {
      const events = JSON.parse(row.events_json) as unknown;
      return Array.isArray(events) && events.includes(event);
    } catch {
      return false;
    }
  });
}

// Record one delivery per subscriber and make the first attempt at once.
export async function enqueueCommentEvent(
  env: Env,
  artifact: Artifact,
  event: CommentEvent,
  comment: ApiComment,
  thread: ApiComment,
  opts: DeliveryOptions = {},
): Promise<DeliveryRow[]> {
  const subscribers = await subscribersFor(
    env,
    artifact.org_id,
    artifact.id,
    event,
  );
  if (!subscribers.length) return [];
  const now = (opts.now || nowSec)();
  const payload = JSON.stringify(
    webhookPayload(env, artifact, event, comment, thread, now),
  );
  const deliveries: DeliveryRow[] = [];
  for (const hook of subscribers) {
    const delivery: DeliveryRow = {
      id: randomId("dlv"),
      webhook_id: hook.id,
      event,
      payload_json: payload,
      attempts: 0,
      next_attempt_at: now,
      delivered_at: null,
      last_status: null,
      last_error: null,
      created_at: now,
    };
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
        (id, webhook_id, event, payload_json, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(delivery.id, hook.id, event, payload, now, now)
      .run();
    deliveries.push(delivery);
  }
  const byId = new Map(subscribers.map((hook) => [hook.id, hook]));
  const attemptAll = async (timeoutMs: number) => {
    for (const delivery of deliveries) {
      const hook = byId.get(delivery.webhook_id);
      if (!hook) continue;
      try {
        await attemptDelivery(env, delivery, hook, {
          ...opts,
          timeoutMs: opts.timeoutMs ?? timeoutMs,
        });
      } catch {
        // The cron picks it up; the comment write already succeeded.
      }
    }
  };
  const background = await backgroundRunner();
  if (background) {
    const work = attemptAll(DELIVERY_TIMEOUT_MS);
    try {
      background(work);
      return deliveries;
    } catch {
      await work;
      return deliveries;
    }
  }
  await attemptAll(INLINE_DELIVERY_TIMEOUT_MS);
  return deliveries;
}

// `waitUntil` from cloudflare:workers attaches to the current request without
// threading an ExecutionContext through every handler. Under node (tests) the
// module does not exist, so the first attempt runs inline.
let runner: ((promise: Promise<unknown>) => void) | null | undefined;
async function backgroundRunner(): Promise<
  ((promise: Promise<unknown>) => void) | null
> {
  if (runner !== undefined) return runner;
  try {
    const mod = (await import("cloudflare:workers")) as {
      waitUntil?: (promise: Promise<unknown>) => void;
    };
    runner = typeof mod.waitUntil === "function" ? mod.waitUntil : null;
  } catch {
    runner = null;
  }
  return runner;
}

// Tests only.
export function resetBackgroundRunner(): void {
  runner = undefined;
}

// One HTTPS POST. Success is any 2xx; redirects are not followed (a receiver
// could otherwise bounce the signed body to an internal host). Failure
// schedules the next attempt per RETRY_BACKOFF_SEC or gives up.
export async function attemptDelivery(
  env: Env,
  delivery: DeliveryRow,
  hook: Pick<WebhookRow, "id" | "url" | "secret">,
  opts: DeliveryOptions = {},
): Promise<AttemptResult> {
  const fetchImpl: FetchLike = opts.fetch || ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const now = (opts.now || nowSec)();
  const body = delivery.payload_json;
  let status: number | null = null;
  let failure: string | null = null;
  try {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "artifact-use-webhooks/1",
        [EVENT_HEADER]: delivery.event,
        [DELIVERY_HEADER]: delivery.id,
        [SIGNATURE_HEADER]: await signWebhookBody(hook.secret, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    if (!response.ok) failure = `receiver answered ${response.status}`;
    // Release the connection without reading a potentially large body.
    try {
      await response.body?.cancel();
    } catch {
      // nothing to release
    }
  } catch (e) {
    failure =
      e instanceof Error && e.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
  }
  const attempts = Number(delivery.attempts || 0) + 1;
  const ok = failure === null;
  const backoff = RETRY_BACKOFF_SEC[attempts - 1];
  const nextAttemptAt = ok || backoff === undefined ? null : now + backoff;
  await env.DB.prepare(
    `UPDATE webhook_deliveries
     SET attempts = ?, next_attempt_at = ?, delivered_at = ?, last_status = ?, last_error = ?
     WHERE id = ?`,
  )
    .bind(
      attempts,
      nextAttemptAt,
      ok ? now : null,
      status,
      failure ? failure.slice(0, 300) : null,
      delivery.id,
    )
    .run();
  await env.DB.prepare(
    "UPDATE artifact_webhooks SET last_delivery_at = ?, last_status = ? WHERE id = ?",
  )
    .bind(now, status, hook.id)
    .run();
  delivery.attempts = attempts;
  delivery.next_attempt_at = nextAttemptAt;
  delivery.delivered_at = ok ? now : null;
  delivery.last_status = status;
  delivery.last_error = failure;
  return {
    ok,
    status,
    error: failure,
    attempts,
    next_attempt_at: nextAttemptAt,
  };
}

// ---- management API: /api/v1/webhooks ----

interface WebhookSummary {
  id: string;
  url: string;
  artifact: string | null;
  events: string[];
  created_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  pending: number;
}

function summarize(
  row: WebhookRow & { artifact_key?: string | null; pending?: number },
): WebhookSummary {
  let events: string[] = [];
  try {
    const parsed = JSON.parse(row.events_json) as unknown;
    if (Array.isArray(parsed)) events = parsed.map(String);
  } catch {
    events = [];
  }
  return {
    id: row.id,
    url: row.url,
    artifact: row.artifact_key || null,
    events,
    created_at: row.created_at,
    last_delivery_at: row.last_delivery_at,
    last_status: row.last_status,
    pending: Number(row.pending || 0),
  };
}

export async function listWebhooks(
  env: Env,
  orgId: string,
): Promise<WebhookSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT w.*, a.url_key AS artifact_key,
       (SELECT COUNT(*) FROM webhook_deliveries d
        WHERE d.webhook_id = w.id AND d.delivered_at IS NULL AND d.next_attempt_at IS NOT NULL) AS pending
     FROM artifact_webhooks w
     LEFT JOIN artifacts a ON a.id = w.artifact_id
     WHERE w.org_id = ? AND w.revoked_at IS NULL
     ORDER BY w.created_at DESC LIMIT 50`,
  )
    .bind(orgId)
    .all<WebhookRow & { artifact_key: string | null; pending: number }>();
  return (rows.results || []).map(summarize);
}

export async function handleWebhooksApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const creatorOrResponse = await safeCreator(request, env);
  if (creatorOrResponse instanceof Response) return creatorOrResponse;
  const creator = creatorOrResponse;
  try {
    if (path === "/api/v1/webhooks") {
      if (request.method === "GET") {
        requirePermission(creator, env, "artifacts:read");
        return json({
          webhooks: await listWebhooks(env, creator.orgId),
          events: [...WEBHOOK_EVENTS],
        });
      }
      if (request.method === "POST") {
        // Subscribing sends comment bodies and viewer emails off-site: the
        // same trust as sharing, so the same permission.
        requirePermission(creator, env, "artifacts:manage_access");
        const body = (await request.json().catch(() => ({}))) as {
          url?: unknown;
          secret?: unknown;
          artifact?: unknown;
          events?: unknown;
        };
        const url = normalizeWebhookUrl(String(body.url || ""), env);
        if (!url)
          return error(
            400,
            "invalid_webhook_url",
            "url must be an https:// URL to a public hostname (no IP literals, credentials, or fragment)",
          );
        const events = normalizeEvents(body.events);
        if (!events)
          return error(
            400,
            "invalid_webhook_events",
            `events must be a subset of: ${WEBHOOK_EVENTS.join(", ")}`,
          );
        let secret = randomSecret();
        if (body.secret !== undefined && body.secret !== null) {
          const given = String(body.secret);
          if (given.length < 8 || given.length > 256)
            return error(
              400,
              "invalid_webhook_secret",
              "secret must be 8 to 256 characters",
            );
          secret = given;
        }
        let artifact: Artifact | null = null;
        const ref = String(body.artifact || "").trim();
        if (ref) {
          artifact =
            (await getArtifactByUrlKey(env, ref)) ||
            (await getArtifactForOrg(env, creator.orgId, ref));
          if (!artifact || artifact.org_id !== creator.orgId)
            return error(404, "artifact_not_found", "artifact not found");
        }
        const active = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM artifact_webhooks WHERE org_id = ? AND revoked_at IS NULL",
        )
          .bind(creator.orgId)
          .first<{ n: number }>();
        if (Number(active?.n || 0) >= MAX_ACTIVE_WEBHOOKS)
          return error(
            409,
            "too_many_webhooks",
            `a workspace may have at most ${MAX_ACTIVE_WEBHOOKS} active webhooks; delete one first`,
          );
        const now = nowSec();
        const id = randomId("whk");
        await env.DB.prepare(
          `INSERT INTO artifact_webhooks
            (id, org_id, artifact_id, url, secret, events_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            creator.orgId,
            artifact?.id || null,
            url,
            secret,
            JSON.stringify(events),
            creator.sub,
            now,
          )
          .run();
        return json({
          webhook: {
            id,
            url,
            artifact: artifact?.url_key || null,
            events,
            created_at: now,
            // Shown once: sign-check every delivery with it.
            secret,
          },
          delivery: {
            headers: [EVENT_HEADER, SIGNATURE_HEADER, DELIVERY_HEADER],
            signature: `${SIGNATURE_HEADER}: sha256=<hex HMAC-SHA256 of the raw body with the secret>`,
            retries:
              "1m, 5m, 30m, 2h, 12h after a non-2xx or timeout (10 s), then dropped",
          },
        });
      }
      return error(405, "method_not_allowed", "method not allowed");
    }
    const match = /^\/api\/v1\/webhooks\/([A-Za-z0-9_-]{1,80})$/.exec(path);
    if (match) {
      if (request.method !== "DELETE")
        return error(405, "method_not_allowed", "method not allowed");
      requirePermission(creator, env, "artifacts:manage_access");
      const result = await env.DB.prepare(
        "UPDATE artifact_webhooks SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL",
      )
        .bind(nowSec(), match[1], creator.orgId)
        .run();
      if (!Number(result.meta?.changes || 0))
        return error(404, "webhook_not_found", "webhook not found");
      // Pending retries for a revoked webhook stop with it.
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE webhook_id = ? AND delivered_at IS NULL",
      )
        .bind(match[1])
        .run();
      return json({ ok: true, revoked: match[1] });
    }
  } catch (e) {
    return error(
      400,
      "webhook_failed",
      e instanceof Error ? e.message : "webhook operation failed",
    );
  }
  return error(404, "not_found", "webhook route not found");
}
