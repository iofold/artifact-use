// Display names: a comment shows the name its author set, else their email's
// local part. Only an identity that proved its email may name it, and the
// team's comments are marked by role, never by name.
import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { normalizeDisplayName } from "../src/profiles.ts";
import { handleProfile } from "../src/serve.ts";
import type { Env, GateLevel } from "../src/types.ts";
import {
  DEV_TOKEN,
  ORG,
  ORIGIN,
  OWNER,
  comments,
  feedbackEnv,
  memberCookie,
  seedArtifact,
  seedShareLink,
  viewerToken,
  type Caller,
} from "./helpers/feedback-env.ts";

const KEY = "dn-abc123";
const ART = "art_dn";

async function setup(
  gate: GateLevel = "verified_email",
  overrides: Partial<Env> = {},
) {
  const { env, raw } = feedbackEnv(overrides);
  seedArtifact(raw, { id: ART, url_key: KEY, gate_level: gate });
  const alice = await viewerToken(env, ART, {
    email: "alice@acme.com",
    verified: true,
  });
  return { env, raw, alice };
}

async function profile(
  env: Env,
  caller: Caller,
  method: "GET" | "POST",
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": "203.0.113.21",
  };
  if (caller && "bearer" in caller)
    headers.Authorization = `Bearer ${caller.bearer}`;
  if (caller && "cookie" in caller) {
    headers.Cookie = caller.cookie;
    headers.Referer = caller.referer || `${ORIGIN}/go/${KEY}/`;
  }
  const res = await handleProfile(
    new Request(
      `${ORIGIN}/_au/profile${method === "GET" ? `?artifact_key=${KEY}` : ""}`,
      {
        method,
        headers,
        ...(method === "POST"
          ? { body: JSON.stringify({ artifact_key: KEY, ...body }) }
          : {}),
      },
    ),
    env,
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

type Listed = { body: string; author_name: string; author_role: string };

async function authors(env: Env, caller: Caller): Promise<string[][]> {
  const list = await comments(env, caller, "GET", KEY);
  return ((list.json.comments as Listed[]) || []).map((c) => [
    c.body,
    c.author_name,
    c.author_role,
  ]);
}

async function me(env: Env, method: "GET" | "PATCH", body?: unknown) {
  const res = await handleAdminApi(
    new Request(`${ORIGIN}/api/v1/me`, {
      method,
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    "/api/v1/me",
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

test("a comment shows the email prefix until its author sets a name", async () => {
  const { env, alice } = await setup();
  await comments(env, { bearer: alice }, "POST", KEY, { body: "First" });
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["First", "alice", "viewer"],
  ]);

  const before = await profile(env, { bearer: alice }, "GET");
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, {
    name: "alice",
    default_name: "alice",
    custom: false,
    can_edit: true,
  });

  const set = await profile(env, { bearer: alice }, "POST", {
    display_name: "  Alice   Chen ",
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.name, "Alice Chen");
  assert.equal(set.json.custom, true);
  // Old comments follow the new name.
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["First", "Alice Chen", "viewer"],
  ]);
  const posted = await comments(env, { bearer: alice }, "POST", KEY, {
    body: "Second",
  });
  assert.equal(
    (posted.json.comment as Listed).author_name,
    "Alice Chen",
    "a fresh comment carries the name too",
  );

  // Clearing goes back to the prefix.
  await profile(env, { bearer: alice }, "POST", { display_name: "" });
  assert.equal(
    (await profile(env, { bearer: alice }, "GET")).json.name,
    "alice",
  );
});

test("names are cleaned, bounded, and never look like an address", () => {
  assert.deepEqual(normalizeDisplayName("  Alice \n  Chen  "), {
    ok: true,
    name: "Alice Chen",
  });
  // Bidi overrides and zero-width characters are dropped.
  assert.deepEqual(normalizeDisplayName("Al‮ice​"), {
    ok: true,
    name: "Alice",
  });
  assert.deepEqual(normalizeDisplayName(""), { ok: true, name: null });
  assert.deepEqual(normalizeDisplayName(null), { ok: true, name: null });
  assert.equal(normalizeDisplayName("x".repeat(61)).ok, false);
  assert.equal(normalizeDisplayName("é".repeat(60)).ok, true);
  assert.equal(normalizeDisplayName("ceo@acme.com").ok, false);
  assert.equal(normalizeDisplayName(42).ok, false);
});

test("only an identity that proved its email can set a name", async () => {
  const { env, raw, alice } = await setup("email");
  await profile(env, { bearer: alice }, "POST", { display_name: "Alice Chen" });
  // Anyone can type alice@acme.com on a plain email gate.
  const impostor = await viewerToken(env, ART, { email: "alice@acme.com" });
  const refused = await profile(env, { bearer: impostor }, "POST", {
    display_name: "Not Alice",
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (refused.json.error as { code: string }).code,
    "name_requires_verification",
  );
  const view = await profile(env, { bearer: impostor }, "GET");
  assert.equal(view.json.can_edit, false);
  assert.equal(view.json.name, "Alice Chen");

  // A shared password link is no one person; an agent acts for its viewer.
  seedShareLink(raw, { id: "lnk_pw", artifact_id: ART, kind: "password" });
  const link = await viewerToken(env, ART, {
    email: "link:lnk_pw",
    link_id: "lnk_pw",
  });
  assert.equal(
    (await profile(env, { bearer: link }, "POST", { display_name: "Acme" }))
      .status,
    403,
  );
  assert.equal(
    (await profile(env, { bearer: link }, "GET")).json.name,
    "Guest",
  );
  const agent = await viewerToken(env, ART, {
    email: "alice@acme.com",
    verified: true,
    agent: "Claude Code",
  });
  assert.equal(
    (await profile(env, { bearer: agent }, "POST", { display_name: "Bot" }))
      .status,
    403,
  );
  assert.equal((await profile(env, null, "GET")).status, 401);
  assert.equal(
    (await profile(env, { bearer: alice }, "POST", { display_name: "a@b.co" }))
      .status,
    400,
  );
});

test("workspace comments carry the team role and resolve to the person", async () => {
  // A workspace token carries no email of its own (an OAuth token may).
  const { env, raw, alice } = await setup("verified_email", {
    DEV_AUTH_EMAIL: "",
  });
  raw
    .prepare(
      "INSERT INTO workspace_memberships (user_id, org_id, org_name, org_slug, role, checked_at) VALUES (?, ?, 'Acme Studio', 'acme', 'admin', 1)",
    )
    .run(OWNER, ORG);
  const reply = await comments(env, { bearer: DEV_TOKEN }, "POST", KEY, {
    body: "From the team",
  });
  assert.equal(reply.status, 200);
  // The credential's user id is unknown here: the workspace's name.
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["From the team", "Acme Studio", "workspace"],
  ]);

  raw
    .prepare(
      "INSERT INTO workos_users (user_id, email, updated_at) VALUES (?, 'yash@iofold.com', 1)",
    )
    .run(OWNER);
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["From the team", "yash", "workspace"],
  ]);

  const named = await me(env, "PATCH", { display_name: "Yash Gupta" });
  assert.equal(named.status, 200);
  assert.equal(
    (named.json.creator as { display_name: string }).display_name,
    "Yash Gupta",
  );
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["From the team", "Yash Gupta", "workspace"],
  ]);
  assert.equal(
    ((await me(env, "GET")).json.creator as { display_name: string })
      .display_name,
    "Yash Gupta",
  );
});

test("a credential whose email is unknown cannot set a name", async () => {
  const { env } = await setup("verified_email", { DEV_AUTH_EMAIL: "" });
  const res = await me(env, "PATCH", { display_name: "Yash" });
  assert.equal(res.status, 409);
  assert.equal((res.json.error as { code: string }).code, "email_unknown");
});

test("a signed-in member names themselves from the widget and posts as the team", async () => {
  const { env, alice } = await setup();
  const cookie = await memberCookie(env, { email: "sam@studio.com" });
  const set = await profile(env, { cookie }, "POST", {
    display_name: "Sam from Studio",
  });
  assert.equal(set.status, 200);
  await comments(env, { cookie }, "POST", KEY, { body: "Hi from Sam" });
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["Hi from Sam", "Sam from Studio", "workspace"],
  ]);
});

test("a viewer who names themselves like the team is still a viewer", async () => {
  const { env, alice } = await setup();
  await profile(env, { bearer: alice }, "POST", { display_name: "Publisher" });
  await comments(env, { bearer: alice }, "POST", KEY, { body: "Trust me" });
  assert.deepEqual(await authors(env, { bearer: alice }), [
    ["Trust me", "Publisher", "viewer"],
  ]);
});
