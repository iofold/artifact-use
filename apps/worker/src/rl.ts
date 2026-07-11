import type { Env } from "./types";
import {
  escapeHtml,
  htmlPage,
  json,
  nowSec,
  sha256Hex,
  wantsHtml,
} from "./util";

const CLEANUP_INTERVAL_SEC = 60 * 60;
const RETENTION_SEC = 2 * 24 * 60 * 60;
let lastCleanupAt: number | null = null;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfter: number;
  windowStart: number;
}

export async function hashRateKey(value: string): Promise<string> {
  return (await sha256Hex(value.trim().toLowerCase())).slice(0, 32);
}

export function requestIp(request: Request): string {
  return (request.headers.get("CF-Connecting-IP") || "unknown")
    .trim()
    .slice(0, 64);
}

export async function rateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSec: number,
  now = nowSec(),
): Promise<RateLimitResult> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindow = Math.max(1, Math.floor(windowSec));
  const windowStart = Math.floor(now / safeWindow) * safeWindow;
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(bucket, window_start)
     DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`,
  )
    .bind(bucket.slice(0, 240), windowStart)
    .first<{ count: number }>();
  if (!row) throw new Error("rate counter did not return a count");

  await maybeCleanup(env, now);
  const count = Number(row.count);
  return {
    allowed: count <= safeLimit,
    count,
    limit: safeLimit,
    retryAfter: Math.max(1, windowStart + safeWindow - now),
    windowStart,
  };
}

export async function clearRateLimit(
  env: Env,
  bucket: string,
  windowSec: number,
  now = nowSec(),
): Promise<void> {
  const safeWindow = Math.max(1, Math.floor(windowSec));
  const windowStart = Math.floor(now / safeWindow) * safeWindow;
  await env.DB.prepare(
    "DELETE FROM rate_counters WHERE bucket = ? AND window_start = ?",
  )
    .bind(bucket.slice(0, 240), windowStart)
    .run();
}

export function rateLimitedResponse(
  result: RateLimitResult,
  request?: Request,
  title = "Please wait",
): Response {
  if (request && wantsHtml(request)) {
    const page = htmlPage(
      title,
      `<h1>Please wait</h1><p class="error">Too many requests. Try again in ${escapeHtml(String(result.retryAfter))} seconds.</p>`,
    );
    const headers = new Headers(page.headers);
    headers.set("Retry-After", String(result.retryAfter));
    return new Response(page.body, { status: 429, headers });
  }
  return json(
    {
      error: {
        code: "rate_limited",
        message: "too many requests; retry later",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfter) },
    },
  );
}

export async function commentWriteRateLimit(
  request: Request,
  env: Env,
  identity: string,
): Promise<Response | null> {
  const identityLimit = await rateLimit(
    env,
    `comments:identity:10m:${await hashRateKey(identity)}`,
    30,
    10 * 60,
  );
  if (!identityLimit.allowed) return rateLimitedResponse(identityLimit);
  const ipLimit = await rateLimit(
    env,
    `comments:ip:hour:${await hashRateKey(requestIp(request))}`,
    60,
    60 * 60,
  );
  return ipLimit.allowed ? null : rateLimitedResponse(ipLimit);
}

async function maybeCleanup(env: Env, now: number): Promise<void> {
  if (lastCleanupAt !== null && now - lastCleanupAt < CLEANUP_INTERVAL_SEC)
    return;
  lastCleanupAt = now;
  await env.DB.prepare("DELETE FROM rate_counters WHERE window_start < ?")
    .bind(now - RETENTION_SEC)
    .run();
}
