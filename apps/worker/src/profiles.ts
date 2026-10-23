// Display names for comment authors.
//
// A person's name is the one they set (profiles, keyed by verified email);
// until then it is their email's local part. Comments written with a
// workspace credential are stored under the WorkOS user id, which resolves
// to an email through workos_users (filled at sign-in and on first use).
import { isWorkosUserId } from "./auth";
import type { Artifact, Env } from "./types";
import { normalizeEmail, nowSec } from "./util";
import { workosApiMaybe } from "./workos";

export const DISPLAY_NAME_MAX = 60;

// What a name falls back to when nobody can be resolved.
export const GUEST_NAME = "Guest";
export const PUBLISHER_NAME = "Publisher";

// Trim, drop control and invisible formatting characters (bidi overrides,
// zero-width joiners), collapse whitespace. Empty clears the name. An "@"
// is refused so a name can never pass for someone's address.
export function normalizeDisplayName(
  input: unknown,
): { ok: true; name: string | null } | { ok: false; message: string } {
  if (input === null || input === undefined) return { ok: true, name: null };
  if (typeof input !== "string")
    return { ok: false, message: "display_name must be a string" };
  const name = input
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return { ok: true, name: null };
  if ([...name].length > DISPLAY_NAME_MAX)
    return {
      ok: false,
      message: `display_name is at most ${DISPLAY_NAME_MAX} characters`,
    };
  if (name.includes("@"))
    return { ok: false, message: "display_name cannot contain @" };
  return { ok: true, name };
}

// "alice" for alice@acme.com; share-link identities are guests and a bare
// WorkOS user id is the publisher until it resolves to a person.
export function fallbackName(author: string): string {
  if (!author || author.startsWith("link:")) return GUEST_NAME;
  if (isWorkosUserId(author)) return PUBLISHER_NAME;
  const at = author.indexOf("@");
  return at > 0 ? author.slice(0, at) : author;
}

export async function getDisplayName(
  env: Env,
  email: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT display_name FROM profiles WHERE email = ?",
  )
    .bind(normalizeEmail(email))
    .first<{ display_name: string }>();
  return row?.display_name || null;
}

// null clears the name, so the email prefix shows again.
export async function setDisplayName(
  env: Env,
  email: string,
  name: string | null,
): Promise<void> {
  const key = normalizeEmail(email);
  if (!name) {
    await env.DB.prepare("DELETE FROM profiles WHERE email = ?")
      .bind(key)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO profiles (email, display_name, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  )
    .bind(key, name, nowSec())
    .run();
}

export async function rememberWorkosUser(
  env: Env,
  userId: string,
  email: string | null,
): Promise<void> {
  if (!isWorkosUserId(userId)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO workos_users (user_id, email, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, email ? normalizeEmail(email) : "", nowSec())
      .run();
  } catch {
    // A name lookup aid; never fail the caller over it.
  }
}

// The email behind a WorkOS user id: the local map first, then WorkOS once
// (remembered either way). null when it cannot be told.
export async function workosUserEmail(
  env: Env,
  userId: string,
): Promise<string | null> {
  if (!isWorkosUserId(userId)) return null;
  const row = await env.DB.prepare(
    "SELECT email FROM workos_users WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ email: string }>();
  if (row) return row.email || null;
  return lookupWorkosUser(env, userId);
}

async function lookupWorkosUser(
  env: Env,
  userId: string,
): Promise<string | null> {
  if (!env.WORKOS_API_KEY) return null;
  try {
    const user = await workosApiMaybe(
      env,
      `/user_management/users/${encodeURIComponent(userId)}`,
    );
    const email = typeof user?.email === "string" ? user.email : null;
    // Remember a deleted user as unknown so it is not asked again.
    await rememberWorkosUser(env, userId, email);
    return email ? normalizeEmail(email) : null;
  } catch {
    // WorkOS unreachable: fall back now, try again next time.
    return null;
  }
}

// D1 caps bound parameters per statement.
const IN_CHUNK = 90;

async function rowsIn<T>(
  env: Env,
  sql: (placeholders: string) => string,
  keys: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const res = await env.DB.prepare(sql(chunk.map(() => "?").join(", ")))
      .bind(...chunk)
      .all<T>();
    out.push(...(res.results || []));
  }
  return out;
}

// At most this many unknown user ids are looked up in WorkOS per call, so a
// comment list never waits on more than a few requests.
const WORKOS_LOOKUPS_PER_CALL = 3;

// Display names for comment authors (an email, a WorkOS user id, or a
// share-link identity), resolved in a few batched reads.
export async function resolveAuthorNames(
  env: Env,
  artifact: Pick<Artifact, "org_id">,
  authors: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(authors.filter(Boolean))];
  const userIds = unique.filter(isWorkosUserId);
  const emailOf = new Map<string, string>();
  if (userIds.length) {
    const known = await rowsIn<{ user_id: string; email: string }>(
      env,
      (p) => `SELECT user_id, email FROM workos_users WHERE user_id IN (${p})`,
      userIds,
    );
    const seen = new Set<string>();
    for (const row of known) {
      seen.add(row.user_id);
      if (row.email) emailOf.set(row.user_id, row.email);
    }
    const missing = userIds.filter((id) => !seen.has(id));
    for (const id of missing.slice(0, WORKOS_LOOKUPS_PER_CALL)) {
      const email = await lookupWorkosUser(env, id);
      if (email) emailOf.set(id, email);
    }
  }
  const emails = [
    ...new Set(
      unique
        .map((a) => emailOf.get(a) || a)
        .filter((a) => a.includes("@") && !a.startsWith("link:"))
        .map(normalizeEmail),
    ),
  ];
  const chosen = new Map<string, string>();
  if (emails.length) {
    const rows = await rowsIn<{ email: string; display_name: string }>(
      env,
      (p) => `SELECT email, display_name FROM profiles WHERE email IN (${p})`,
      emails,
    );
    for (const row of rows) chosen.set(row.email, row.display_name);
  }
  let workspaceName: string | null | undefined;
  for (const author of unique) {
    const email = isWorkosUserId(author) ? emailOf.get(author) : author;
    if (email && email.includes("@")) {
      names.set(
        author,
        chosen.get(normalizeEmail(email)) || fallbackName(email),
      );
      continue;
    }
    if (isWorkosUserId(author)) {
      // Nobody to name: the workspace itself.
      if (workspaceName === undefined)
        workspaceName = await orgName(env, artifact.org_id);
      names.set(author, workspaceName || PUBLISHER_NAME);
      continue;
    }
    names.set(author, fallbackName(author));
  }
  return names;
}

async function orgName(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT org_name FROM workspace_memberships WHERE org_id = ? AND org_name != '' LIMIT 1",
  )
    .bind(orgId)
    .first<{ org_name: string }>();
  return row?.org_name || null;
}
