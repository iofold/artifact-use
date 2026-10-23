// Private feedback: with feedback_mode = 'private' each viewer sees only the
// threads they started (plus the workspace's replies in them), the publishing
// workspace sees every thread, and nothing a viewer cannot see can be reached
// by id, by reply, by resolve/re-anchor, or by replaying a client_ref.
import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { handleArtifactContext } from "../src/serve.ts";
import {
  DEV_TOKEN,
  ORIGIN,
  bodies,
  comments,
  feedbackEnv,
  memberCookie,
  seedArtifact,
  seedShareLink,
  viewerToken,
} from "./helpers/feedback-env.ts";
import type { Env } from "../src/types.ts";

const KEY = "pf-abc123";
const ART = "art_pf";

async function setup(
  fields: {
    gate?: "public" | "email" | "verified_email";
    mode?: "shared" | "private";
  } = {},
) {
  const { env, raw } = feedbackEnv();
  seedArtifact(raw, {
    id: ART,
    url_key: KEY,
    gate_level: fields.gate || "verified_email",
    feedback_mode: fields.mode || "private",
  });
  const alice = await viewerToken(env, ART, {
    email: "alice@acme.com",
    verified: true,
  });
  const bob = await viewerToken(env, ART, {
    email: "bob@globex.com",
    verified: true,
  });
  const setMode = (mode: "shared" | "private") =>
    raw
      .prepare("UPDATE artifacts SET feedback_mode = ? WHERE id = ?")
      .run(mode, ART);
  return { env, raw, alice, bob, setMode };
}

async function post(
  env: Env,
  bearer: string,
  body: string,
  extra: Record<string, unknown> = {},
) {
  const res = await comments(env, { bearer }, "POST", KEY, { body, ...extra });
  return res;
}

function idOf(res: { json: Record<string, unknown> }): number {
  return Number((res.json.comment as { id: number }).id);
}

test("each customer sees only their own threads; the workspace sees all", async () => {
  const { env, alice, bob } = await setup();
  const a = await post(env, alice, "Alice: pricing table is wrong");
  assert.equal(a.status, 200);
  assert.equal((a.json.comment as { private: boolean }).private, true);
  await post(env, bob, "Bob: love the hero");

  assert.deepEqual(bodies(await comments(env, { bearer: alice }, "GET", KEY)), [
    "Alice: pricing table is wrong",
  ]);
  const bobList = await comments(env, { bearer: bob }, "GET", KEY);
  assert.deepEqual(bodies(bobList), ["Bob: love the hero"]);
  assert.equal(bobList.json.count, 1);

  const creator = await comments(env, { bearer: DEV_TOKEN }, "GET", KEY);
  assert.equal(creator.status, 200);
  assert.equal(bodies(creator).length, 2);
  const member = await comments(
    env,
    { cookie: await memberCookie(env) },
    "GET",
    KEY,
  );
  assert.equal(bodies(member).length, 2);

  // A member who also passed the gate (viewer cookie) still sees everything.
  const both = `${await memberCookie(env)}; au_${ART}=${encodeURIComponent(alice)}`;
  assert.equal(
    bodies(await comments(env, { cookie: both }, "GET", KEY)).length,
    2,
  );
});

test("workspace replies reach only the thread's owner; workspace-started threads stay internal", async () => {
  const { env, alice, bob } = await setup();
  const a = await post(env, alice, "Alice root");
  await comments(env, { bearer: DEV_TOKEN }, "POST", KEY, {
    body: "Fixed in v2, Alice",
    parent_id: idOf(a),
  });
  await comments(env, { bearer: DEV_TOKEN }, "POST", KEY, {
    body: "Internal note for the team",
  });

  assert.deepEqual(bodies(await comments(env, { bearer: alice }, "GET", KEY)), [
    "Alice root",
    "Fixed in v2, Alice",
  ]);
  assert.deepEqual(
    bodies(await comments(env, { bearer: bob }, "GET", KEY)),
    [],
  );
  const all = bodies(await comments(env, { bearer: DEV_TOKEN }, "GET", KEY));
  assert.ok(all.includes("Internal note for the team"));
});

test("another viewer cannot reach a private thread by id", async () => {
  const { env, alice, bob } = await setup();
  const a = await post(env, alice, "Alice only", {
    target: { selector: "#price", label: "Pricing", path: "/go/pf-abc123" },
  });
  const id = idOf(a);

  const reply = await post(env, bob, "Bob sneaking in", { parent_id: id });
  assert.equal(reply.status, 404);
  assert.equal(
    (reply.json.error as { code: string }).code,
    "comment_not_found",
  );
  const resolve = await comments(env, { bearer: bob }, "PATCH", KEY, {
    id,
    resolved: true,
  });
  assert.equal(resolve.status, 404);
  const reanchor = await comments(env, { bearer: bob }, "PATCH", KEY, {
    id,
    target: { selector: "#x", label: "x", path: "/go/pf-abc123" },
  });
  assert.equal(reanchor.status, 404);

  // The owner still can.
  assert.equal(
    (
      await comments(env, { bearer: alice }, "PATCH", KEY, {
        id,
        resolved: true,
      })
    ).status,
    200,
  );
});

test("replaying someone else's client_ref never returns their comment", async () => {
  const { env, alice, bob } = await setup();
  const first = await post(env, alice, "Alice draft", { client_ref: "ref-1" });
  assert.equal(first.status, 200);
  const retry = await post(env, alice, "Alice draft", { client_ref: "ref-1" });
  assert.equal(retry.status, 200);
  assert.equal(idOf(retry), idOf(first));

  const stolen = await post(env, bob, "anything", { client_ref: "ref-1" });
  assert.equal(stolen.status, 409);
  assert.equal(
    (stolen.json.error as { code: string }).code,
    "client_ref_conflict",
  );
  assert.ok(!JSON.stringify(stolen.json).includes("Alice draft"));
});

test("the long-poll answers only with comments the caller may see", async () => {
  const { env, alice, bob } = await setup();
  await post(env, alice, "Alice while Bob waits");
  const held = await comments(
    env,
    { bearer: bob },
    "GET",
    KEY,
    {},
    "&since=1&wait=1",
  );
  assert.equal(held.status, 200);
  assert.deepEqual(bodies(held), []);
});

test("switching private off never reveals threads written privately", async () => {
  const { env, alice, bob, setMode } = await setup();
  await post(env, alice, "Written while private");
  await comments(env, { bearer: DEV_TOKEN }, "POST", KEY, {
    body: "Team note while private",
  });
  setMode("shared");
  await post(env, alice, "Written after switching to shared");

  assert.deepEqual(bodies(await comments(env, { bearer: bob }, "GET", KEY)), [
    "Written after switching to shared",
  ]);
  assert.deepEqual(bodies(await comments(env, { bearer: alice }, "GET", KEY)), [
    "Written after switching to shared",
    "Written while private",
  ]);
});

test("switching private on hides other viewers' older threads but keeps your own", async () => {
  const { env, alice, bob, setMode } = await setup({ mode: "shared" });
  await post(env, alice, "Alice before");
  await post(env, bob, "Bob before");
  assert.equal(
    bodies(await comments(env, { bearer: bob }, "GET", KEY)).length,
    2,
  );
  setMode("private");
  assert.deepEqual(bodies(await comments(env, { bearer: alice }, "GET", KEY)), [
    "Alice before",
  ]);
  assert.deepEqual(bodies(await comments(env, { bearer: bob }, "GET", KEY)), [
    "Bob before",
  ]);
});

test("on plain email access an unverified viewer is scoped to their own session", async () => {
  const { env } = await setup({ gate: "email" });
  const carol = await viewerToken(env, ART, {
    email: "carol@initech.com",
    view_id: 501,
  });
  // Anyone can type Carol's address on the email gate.
  const impostor = await viewerToken(env, ART, {
    email: "carol@initech.com",
    view_id: 502,
  });
  const carolsAgent = await viewerToken(env, ART, {
    email: "carol@initech.com",
    view_id: 501,
    agent: "delegated",
  });
  await post(env, carol, "Carol's real feedback");

  assert.deepEqual(bodies(await comments(env, { bearer: carol }, "GET", KEY)), [
    "Carol's real feedback",
  ]);
  assert.deepEqual(
    bodies(await comments(env, { bearer: carolsAgent }, "GET", KEY)),
    ["Carol's real feedback"],
  );
  assert.deepEqual(
    bodies(await comments(env, { bearer: impostor }, "GET", KEY)),
    [],
  );
});

test("everyone who opens the same password link shares one thread pool", async () => {
  const { env, raw } = await setup({ gate: "email" });
  seedShareLink(raw, { id: "lnk_acme", artifact_id: ART, kind: "password" });
  seedShareLink(raw, { id: "lnk_globex", artifact_id: ART, kind: "password" });
  const acme1 = await viewerToken(env, ART, {
    email: "link:lnk_acme",
    link_id: "lnk_acme",
  });
  const acme2 = await viewerToken(env, ART, {
    email: "link:lnk_acme",
    link_id: "lnk_acme",
  });
  const globex = await viewerToken(env, ART, {
    email: "link:lnk_globex",
    link_id: "lnk_globex",
  });
  await post(env, acme1, "Acme team thread");
  assert.deepEqual(bodies(await comments(env, { bearer: acme2 }, "GET", KEY)), [
    "Acme team thread",
  ]);
  assert.deepEqual(
    bodies(await comments(env, { bearer: globex }, "GET", KEY)),
    [],
  );
});

test("anonymous readers of a public artifact see nothing once it is private", async () => {
  const { env, setMode } = await setup({ gate: "public", mode: "shared" });
  await comments(env, { bearer: DEV_TOKEN }, "POST", KEY, {
    body: "Published note",
  });
  assert.deepEqual(bodies(await comments(env, null, "GET", KEY)), [
    "Published note",
  ]);
  setMode("private");
  assert.deepEqual(bodies(await comments(env, null, "GET", KEY)), []);
});

test("the widget learns the mode from artifact-context", async () => {
  const { env } = await setup();
  const res = await handleArtifactContext(
    new Request(`${ORIGIN}/_au/artifact-context?artifact_key=${KEY}`),
    env,
  );
  const body = (await res.json()) as { role: string; feedback: string };
  assert.equal(body.role, "viewer");
  assert.equal(body.feedback, "private");
});

test("PATCH /api/v1/artifacts/{key} turns private feedback on and validates it", async () => {
  const { env } = await setup({ mode: "shared" });
  const patch = (body: unknown) =>
    handleAdminApi(
      new Request(`${ORIGIN}/api/v1/artifacts/${KEY}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${DEV_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      `/api/v1/artifacts/${KEY}`,
    );
  const on = await patch({ feedback: "private" });
  assert.equal(on.status, 200);
  assert.equal(
    ((await on.json()) as { artifact: { feedback_mode: string } }).artifact
      .feedback_mode,
    "private",
  );
  const bad = await patch({ feedback: "secret" });
  assert.equal(bad.status, 400);
  assert.equal(
    ((await bad.json()) as { error: { code: string } }).error.code,
    "invalid_feedback",
  );
});
