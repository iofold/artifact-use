import type { Env, PublisherSession } from "./types";
import { mintCreatorToken } from "./auth";
import { agentSetupPrompt } from "./llms";
import { error, json, nowSec, randomId, siteBaseUrl } from "./util";

// Device-code style handoff: an agent with no token and no browser requests a
// code, the human approves it in a signed-in session, and the agent polls the
// device_code for a creator bearer token. The token is delivered exactly once.

const CONNECT_TTL_SEC = 15 * 60;
const CONNECT_TOKEN_DAYS = 30;
const POLL_INTERVAL_SEC = 3;
// No 0/O/1/I/L — a human retypes this code.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export type ConnectRequestRow = {
  device_code: string;
  user_code: string;
  status: "pending" | "approved" | "claimed";
  agent_label: string | null;
  token: string | null;
  token_id: string | null;
  org_id: string | null;
  approved_by: string | null;
  created_at: number;
  expires_at: number;
};

export async function handleConnectApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if (request.method !== "POST")
    return error(405, "method_not_allowed", "method not allowed");
  if (path === "/api/v1/connect/start") return startConnect(request, env);
  if (path === "/api/v1/connect/poll") return pollConnect(request, env);
  return error(404, "not_found", "connect route not found");
}

async function startConnect(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    agent_label?: unknown;
  };
  const label = body.agent_label ? String(body.agent_label).slice(0, 80) : null;
  const now = nowSec();
  const deviceCode = randomId("dc");
  const userCode = newUserCode();
  await env.DB.prepare(
    `INSERT INTO connect_requests
     (device_code, user_code, status, agent_label, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(deviceCode, userCode, label, now, now + CONNECT_TTL_SEC)
    .run();
  const verificationUrl = `${siteBaseUrl(env)}/connect?code=${userCode}`;
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_url: verificationUrl,
    expires_in: CONNECT_TTL_SEC,
    interval: POLL_INTERVAL_SEC,
    next: `Tell your human: "Approve code ${userCode} at ${verificationUrl}" — then POST {"device_code": "..."} to /api/v1/connect/poll every ${POLL_INTERVAL_SEC}s until you receive your token.`,
  });
}

async function pollConnect(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    device_code?: unknown;
  };
  const deviceCode = String(body.device_code || "");
  if (!deviceCode.startsWith("dc_"))
    return error(400, "device_code_required", "device_code is required");
  const row = await env.DB.prepare(
    "SELECT * FROM connect_requests WHERE device_code = ?",
  )
    .bind(deviceCode)
    .first<ConnectRequestRow>();
  if (!row) return error(404, "connect_not_found", "connect request not found");
  if (row.status === "claimed")
    return error(
      410,
      "token_already_claimed",
      "the token for this connect request was already delivered",
    );
  if (row.status === "pending") {
    if (row.expires_at < nowSec())
      return error(
        410,
        "connect_expired",
        "connect request expired before approval; start a new one",
      );
    return json({ status: "pending", interval: POLL_INTERVAL_SEC });
  }
  // Approved: deliver the token exactly once.
  if (!row.token || !row.token_id)
    return error(500, "connect_corrupt", "approved request is missing token");
  const tokenRow = await env.DB.prepare(
    "SELECT expires_at FROM creator_tokens WHERE id = ?",
  )
    .bind(row.token_id)
    .first<{ expires_at: number }>();
  const claimed = await env.DB.prepare(
    "UPDATE connect_requests SET status = 'claimed', token = NULL WHERE device_code = ? AND status = 'approved'",
  )
    .bind(deviceCode)
    .run();
  if (!claimed.meta.changes)
    return error(
      410,
      "token_already_claimed",
      "the token for this connect request was already delivered",
    );
  const expiresAt = tokenRow?.expires_at || nowSec();
  return json({
    status: "approved",
    token: row.token,
    token_type: "Bearer",
    expires_at: expiresAt,
    prompt: agentSetupPrompt(env, row.token, expiresAt),
  });
}

// Look up the newest pending, unexpired request for a human-entered code.
export async function pendingConnectRequest(
  env: Env,
  userCode: string,
): Promise<ConnectRequestRow | null> {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM connect_requests
     WHERE user_code = ? AND status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(code, nowSec())
    .first<ConnectRequestRow>();
  return row || null;
}

// Approve a pending request in the approver's org: mint a creator token and
// park it on the row for the agent's next poll.
export async function approveConnectRequest(
  env: Env,
  row: ConnectRequestRow,
  session: PublisherSession,
): Promise<{ ok: boolean; label: string }> {
  const label =
    row.agent_label || `Agent connect ${row.user_code.replace("-", "")}`;
  const minted = await mintCreatorToken(env, {
    sub: session.sub,
    orgId: session.orgId,
    email: session.email,
    label,
    source: "connect",
    expiresDays: CONNECT_TOKEN_DAYS,
  });
  const result = await env.DB.prepare(
    `UPDATE connect_requests
     SET status = 'approved', token = ?, token_id = ?, org_id = ?, approved_by = ?
     WHERE device_code = ? AND status = 'pending'`,
  )
    .bind(minted.token, minted.id, session.orgId, session.sub, row.device_code)
    .run();
  // Lost race (double submit): revoke the token we minted for nothing.
  if (!result.meta.changes) {
    await env.DB.prepare(
      "UPDATE creator_tokens SET revoked_at = ? WHERE id = ?",
    )
      .bind(nowSec(), minted.id)
      .run();
    return { ok: false, label };
  }
  return { ok: true, label };
}

export function normalizeUserCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^2-9A-Z]/g, "");
  if (cleaned.length !== 8) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

function newUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes)
    out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
