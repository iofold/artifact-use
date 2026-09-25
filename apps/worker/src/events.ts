// Hosted MCP instrumentation. Until this existed the worker recorded nothing
// about agents: no client name, no tool outcome, no error code. The operator
// could not answer "which harness publishes" or "why do publishes fail".
import type { Creator, Env } from "./types";
import { nowSec, randomId } from "./util";

export type AuthKind = "creator_token" | "oauth" | "dev" | "none";

export interface McpEventInput {
  creator: Creator | null;
  authKind: AuthKind;
  client: string | null;
  clientVersion: string | null;
  userAgent: string;
  protocolVersion: string | null;
  method: string;
  tool?: string | null;
  action?: string | null;
  ok: boolean;
  status?: number | null;
  errorCode?: string | null;
  durationMs: number;
}

export function authKindFor(creator: Creator | null): AuthKind {
  if (!creator) return "none";
  if (creator.raw.creator_token) return "creator_token";
  if (creator.raw.dev) return "dev";
  return "oauth";
}

// Normalize the harness from a User-Agent. Modern (2026-07-28) requests also
// carry clientInfo in _meta, which wins when present.
export function clientFromUserAgent(ua: string): {
  client: string;
  version: string | null;
} {
  const rules: Array<[RegExp, string]> = [
    [/claude-code\/([\w.-]+)/i, "claude-code"],
    [/^Claude-User/i, "claude-ai"],
    [/codex-mcp-client\/([\w.-]+)/i, "codex"],
    [/codex\/([\w.-]+)/i, "codex"],
    [/opencode\/?([\w.-]*)/i, "opencode"],
    [/hermes-agent\/?([\w.-]*)/i, "hermes"],
    [/cursor\/?([\w.-]*)/i, "cursor"],
    [/kiro\/?([\w.-]*)/i, "kiro"],
    [/python-httpx2?\/([\w.-]+)/i, "python-httpx"],
    [/python-requests\/([\w.-]+)/i, "python-requests"],
    [/Python-urllib\/([\w.-]+)/i, "python-urllib"],
    [/aiohttp\/([\w.-]+)/i, "aiohttp"],
    [/Bun\/([\w.-]+)/i, "bun"],
    [/^node(?:-fetch)?\/?([\w.-]*)|undici/i, "node"],
    [/curl\/([\w.-]+)/i, "curl"],
    [/Go-http-client\/([\w.-]+)/i, "go"],
    [/Mozilla\//, "browser"],
  ];
  for (const [pattern, client] of rules) {
    const match = pattern.exec(ua);
    if (match) return { client, version: match[1] || null };
  }
  const head = ua.split(/[\s/]/)[0]?.toLowerCase().slice(0, 40);
  return { client: head || "unknown", version: null };
}

export async function recordMcpEvent(
  env: Env,
  event: McpEventInput,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO mcp_events
        (id, ts, org_id, user_id, token_id, auth_kind, client, client_version,
         user_agent, protocol_version, method, tool, action, ok, status,
         error_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        randomId("evt"),
        nowSec(),
        event.creator?.orgId || null,
        event.creator?.sub || null,
        typeof event.creator?.raw.token_id === "string"
          ? event.creator.raw.token_id
          : null,
        event.authKind,
        event.client,
        event.clientVersion,
        event.userAgent.slice(0, 200),
        event.protocolVersion,
        event.method,
        event.tool || null,
        event.action || null,
        event.ok ? 1 : 0,
        event.status ?? null,
        event.errorCode || null,
        Math.max(0, Math.round(event.durationMs)),
      )
      .run();
  } catch {
    // Instrumentation never fails a request.
  }
}
