// A real-schema environment for comment visibility and gate tests: node:sqlite
// with every migration applied, one workspace, and helpers that call the
// viewer comments route the way the widget and agents do.
import type { DatabaseSync } from "node:sqlite";
import { signPayload, signViewerSession } from "../../src/auth.ts";
import { handleComments } from "../../src/serve.ts";
import type { Env, GateLevel, PublisherSession } from "../../src/types.ts";
import { nowSec } from "../../src/util.ts";
import { sqliteD1 } from "./sqlite-d1.ts";

export const ORIGIN = "https://artifacts.example.com";
export const ORG = "org_feedback";
export const OWNER = "user_01FEEDBACKOWNER";
export const DEV_TOKEN = "local-publisher-token";

export interface FeedbackEnv {
  env: Env;
  raw: DatabaseSync;
}

export function feedbackEnv(overrides: Partial<Env> = {}): FeedbackEnv {
  const { db, raw } = sqliteD1();
  const env = {
    DB: db,
    SESSION_SECRET: "feedback-secret",
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    DEV_AUTH_TOKEN: DEV_TOKEN,
    DEV_AUTH_USER_ID: OWNER,
    DEV_AUTH_ORG_ID: ORG,
    DEV_AUTH_EMAIL: "publisher@example.com",
    ...overrides,
  } as unknown as Env;
  return { env, raw };
}

export function seedArtifact(
  raw: DatabaseSync,
  fields: {
    id: string;
    url_key: string;
    gate_level?: GateLevel;
    feedback_mode?: "shared" | "private";
    allowlist_json?: string | null;
  },
): void {
  raw
    .prepare(
      `INSERT INTO artifacts (id, org_id, slug, url_key, title, gate_level, allowlist_json, current_version_id, created_by, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ver_1', ?, 1, 1, 'active')`,
    )
    .run(
      fields.id,
      ORG,
      fields.id,
      fields.url_key,
      `Artifact ${fields.id}`,
      fields.gate_level || "email",
      fields.allowlist_json ?? null,
      OWNER,
    );
  if (fields.feedback_mode)
    raw
      .prepare("UPDATE artifacts SET feedback_mode = ? WHERE id = ?")
      .run(fields.feedback_mode, fields.id);
}

export function seedShareLink(
  raw: DatabaseSync,
  fields: {
    id: string;
    artifact_id: string;
    kind?: "recipient" | "password" | "open";
    recipient_email?: string | null;
    revoked_at?: number | null;
    expires_at?: number | null;
  },
): void {
  raw
    .prepare(
      `INSERT INTO share_links (id, artifact_id, kind, recipient_email, revoked_at, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      fields.id,
      fields.artifact_id,
      fields.kind || "recipient",
      fields.recipient_email ?? null,
      fields.revoked_at ?? null,
      fields.expires_at ?? null,
      OWNER,
    );
}

let nextViewId = 100;

export async function viewerToken(
  env: Env,
  artifactId: string,
  fields: {
    email: string;
    verified?: boolean;
    view_id?: number;
    link_id?: string;
    agent?: string;
  },
): Promise<string> {
  return signViewerSession(
    {
      artifact_id: artifactId,
      version_id: "ver_1",
      email: fields.email,
      verified: fields.verified ?? false,
      view_id: fields.view_id ?? nextViewId++,
      exp: nowSec() + 600,
      ...(fields.link_id ? { link_id: fields.link_id } : {}),
      ...(fields.agent ? { agent: fields.agent } : {}),
    },
    env,
  );
}

// The site-wide publisher cookie of a signed-in workspace member.
export async function memberCookie(
  env: Env,
  fields: { sub?: string; email?: string; orgId?: string } = {},
): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: fields.sub || "user_01FEEDBACKMEMBER",
    orgId: fields.orgId || ORG,
    email: fields.email || "member@example.com",
    name: null,
    roles: ["member"],
    exp: nowSec() + 3600,
  };
  return `au_pub=${encodeURIComponent(await signPayload(session, env))}`;
}

export type Caller =
  { bearer: string } | { cookie: string; referer?: string } | null;

export async function comments(
  env: Env,
  caller: Caller,
  method: "GET" | "POST" | "PATCH",
  artifactKey: string,
  body: Record<string, unknown> = {},
  query = "",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": "203.0.113.20",
  };
  if (caller && "bearer" in caller)
    headers.Authorization = `Bearer ${caller.bearer}`;
  if (caller && "cookie" in caller) {
    headers.Cookie = caller.cookie;
    headers.Referer =
      caller.referer || `${ORIGIN}/go/${artifactKey}/index.html`;
  }
  const search =
    method === "GET"
      ? `?artifact_key=${encodeURIComponent(artifactKey)}${query}`
      : "";
  const res = await handleComments(
    new Request(`${ORIGIN}/_au/comments${search}`, {
      method,
      headers,
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify({ artifact_key: artifactKey, ...body }) }),
    }),
    env,
    "/_au/comments",
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

export function bodies(list: { json: Record<string, unknown> }): string[] {
  return ((list.json.comments as { body: string }[]) || []).map((c) => c.body);
}
