import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { signCreatorToken, signViewerSession } from "../src/auth.ts";
import {
  canonicalPagePath,
  clampWait,
  LONG_POLL_MAX_SEC,
  resetArtifactWatchThrottle,
  waitForComments,
} from "../src/comments.ts";
import { handleComments } from "../src/serve.ts";
import type { Env } from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import {
  loopArtifact,
  newStore,
  seedComment,
  seedWebhook,
  storeEnv,
  type Store,
} from "./helpers/comment-store.ts";

const ORIGIN = "https://artifacts.example.com";
const KEY = loopArtifact.url_key;
const API_PATH = `/api/v1/artifacts/${KEY}/comments`;

async function viewerToken(
  env: Env,
  extra: { agent?: string; email?: string } = {},
): Promise<string> {
  return signViewerSession(
    {
      artifact_id: loopArtifact.id,
      version_id: "ver_loop",
      email: extra.email || "reviewer@example.com",
      verified: false,
      view_id: 7,
      exp: nowSec() + 600,
      ...(extra.agent ? { agent: extra.agent } : {}),
    },
    env,
  );
}

function widget(
  env: Env,
  method: string,
  token: string,
  body?: unknown,
  query = "",
): Promise<Response> {
  return handleComments(
    new Request(`${ORIGIN}/_au/comments${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
      },
      ...(body ? { body: JSON.stringify({ artifact_key: KEY, ...body }) } : {}),
    }),
    env,
    "/_au/comments",
  );
}

function creatorApi(
  env: Env,
  method: string,
  token: string,
  body?: unknown,
  query = "",
): Promise<Response> {
  return handleAdminApi(
    new Request(`${ORIGIN}${API_PATH}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    API_PATH,
  );
}

async function labelledCreatorToken(env: Env, name: string): Promise<string> {
  const now = nowSec();
  return signCreatorToken(
    {
      typ: "creator",
      sub: "user_01AGENTTOKEN",
      org_id: loopArtifact.org_id,
      email: null,
      name,
      permissions: ["artifacts:publish", "artifacts:read"],
      iat: now,
      exp: now + 3600,
    },
    env,
  );
}

function fresh(): { store: Store; env: Env } {
  resetArtifactWatchThrottle();
  const store = newStore([loopArtifact]);
  return { store, env: storeEnv(store) };
}

test("creator-token writes are the agent's, under the token label; viewer writes stay human", async () => {
  const { env } = fresh();
  const viaApi = await creatorApi(
    env,
    "POST",
    await labelledCreatorToken(env, "Claude Code"),
    { body: "Fixed in v2: the chart sorts by date." },
  );
  assert.equal(viaApi.status, 200);
  const agent = (await viaApi.json()).comment;
  assert.equal(agent.author_kind, "agent");
  assert.equal(agent.agent_label, "Claude Code");
  assert.equal(agent.email, "user_01AGENTTOKEN");

  const viaWidget = await widget(env, "POST", await viewerToken(env), {
    body: "Make the chart bigger",
  });
  assert.equal(viaWidget.status, 200);
  const human = (await viaWidget.json()).comment;
  assert.equal(human.author_kind, "human");
  assert.equal(human.agent_label, null);

  // "Hand to your agent" sessions write as an agent under the viewer's email.
  const delegated = await widget(
    env,
    "POST",
    await viewerToken(env, { agent: "delegated" }),
    { body: "Audit: contrast on the legend is below 4.5:1" },
  );
  const audit = (await delegated.json()).comment;
  assert.equal(audit.author_kind, "agent");
  assert.equal(audit.agent_label, "delegated");
  assert.equal(audit.email, "reviewer@example.com");

  // The list carries the attribution.
  const list = await widget(
    env,
    "GET",
    await viewerToken(env),
    undefined,
    `?artifact_key=${KEY}`,
  );
  const kinds = (await list.json()).comments.map(
    (c: { author_kind: string; agent_label: string | null }) =>
      `${c.author_kind}:${c.agent_label ?? ""}`,
  );
  assert.deepEqual(kinds.sort(), [
    "agent:Claude Code",
    "agent:delegated",
    "human:",
  ]);
});

test("page_path is one key per page: index.html and the trailing slash go on write, either form reads", async () => {
  const { store, env } = fresh();
  const token = await viewerToken(env);
  for (const page_path of [
    `/go/${KEY}/`,
    `/go/${KEY}/index.html`,
    `/go/${KEY}`,
    `${ORIGIN}/go/${KEY}/index.html`,
  ]) {
    const res = await widget(env, "POST", token, {
      body: "root page",
      page_path,
    });
    assert.equal(res.status, 200, page_path);
    assert.equal((await res.json()).comment.page_path, `/go/${KEY}`, page_path);
  }
  // A target's path feeds page_path the same way; the target itself keeps
  // the raw path it was captured with.
  const anchored = await widget(env, "POST", token, {
    body: "hero",
    target: { selector: "#hero", label: "hero", path: `/go/${KEY}/index.html` },
  });
  const anchoredComment = (await anchored.json()).comment;
  assert.equal(anchoredComment.page_path, `/go/${KEY}`);
  assert.equal(anchoredComment.target.path, `/go/${KEY}/index.html`);
  assert.equal(anchoredComment.target.v, 3);
  // Sub-pages: a directory index folds onto its directory; files stay.
  const dir = await widget(env, "POST", token, {
    body: "reports",
    page_path: `/go/${KEY}/reports/index.html`,
  });
  assert.equal((await dir.json()).comment.page_path, `/go/${KEY}/reports`);
  const file = await widget(env, "POST", token, {
    body: "reports page",
    page_path: `/go/${KEY}/reports.html`,
  });
  assert.equal(
    (await file.json()).comment.page_path,
    `/go/${KEY}/reports.html`,
  );
  // A stray path is clamped to the artifact root on write.
  const stray = await widget(env, "POST", token, {
    body: "stray",
    page_path: "/",
  });
  assert.equal((await stray.json()).comment.page_path, `/go/${KEY}`);

  // Reads accept any spelling of the page.
  for (const q of [`/go/${KEY}/`, `/go/${KEY}/index.html`, `/go/${KEY}`]) {
    const res = await widget(
      env,
      "GET",
      token,
      undefined,
      `?artifact_key=${KEY}&page_path=${encodeURIComponent(q)}`,
    );
    assert.equal((await res.json()).count, 6, q);
  }
  // A foreign path on read matches nothing instead of the root.
  const foreign = await widget(
    env,
    "GET",
    token,
    undefined,
    `?artifact_key=${KEY}&page_path=${encodeURIComponent("/go/other-artifact/")}`,
  );
  assert.equal((await foreign.json()).count, 0);
  assert.equal(store.comments.length, 8);

  assert.equal(canonicalPagePath("/go/x/index.html"), "/go/x");
  assert.equal(canonicalPagePath("/go/x/"), "/go/x");
  assert.equal(canonicalPagePath("/go/x/a/index.htm"), "/go/x/a");
  assert.equal(canonicalPagePath("/go/x/a.html"), "/go/x/a.html");
});

test("Send to agent flags the thread root, fires comment.sent_to_agent, and surfaces under status=sent", async () => {
  const { store, env } = fresh();
  seedWebhook(store, {
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/au",
    events_json: JSON.stringify(["comment.sent_to_agent"]),
  });
  const root = seedComment(store, {
    artifact_id: loopArtifact.id,
    body: "Swap the hero image",
    created_at: 1_800_000_000,
  });
  const reply = seedComment(store, {
    artifact_id: loopArtifact.id,
    body: "Which one?",
    parent_comment_id: root.id,
    created_at: 1_800_000_010,
  });
  seedComment(store, {
    artifact_id: loopArtifact.id,
    body: "Typo in the footer",
    created_at: 1_800_000_020,
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    // Flagging a reply flags its root.
    const sent = await widget(env, "PATCH", await viewerToken(env), {
      id: reply.id,
      sent_to_agent: true,
    });
    assert.equal(sent.status, 200);
    const flagged = (await sent.json()).comment;
    assert.equal(flagged.id, root.id);
    assert.ok(flagged.sent_to_agent_at > 0);
    assert.equal(root.sent_to_agent_at, flagged.sent_to_agent_at);

    // The event went out at once, signed, with the root as comment and thread.
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, "https://hooks.example.com/au");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("X-Artifact-Use-Event"), "comment.sent_to_agent");
    assert.match(
      String(headers.get("X-Artifact-Use-Signature")),
      /^sha256=[0-9a-f]{64}$/,
    );
    assert.match(String(headers.get("X-Artifact-Use-Delivery")), /^dlv_/);
    const payload = JSON.parse(String(call.init.body));
    assert.equal(payload.event, "comment.sent_to_agent");
    assert.equal(payload.comment.id, root.id);
    assert.equal(payload.thread.id, root.id);
    assert.equal(payload.comment.sent_to_agent_at, flagged.sent_to_agent_at);
    assert.deepEqual(payload.artifact, {
      id: loopArtifact.id,
      url_key: KEY,
      url: `${ORIGIN}/go/${KEY}/`,
      title: loopArtifact.title,
    });
    assert.equal(store.deliveries.length, 1);
    assert.ok(store.deliveries[0]!.delivered_at);

    // The publisher's agent sees the flagged thread (with its replies) first.
    const queue = await creatorApi(
      env,
      "GET",
      "local-publisher-token",
      undefined,
      "?status=sent",
    );
    assert.equal(queue.status, 200);
    const queued = await queue.json();
    assert.deepEqual(
      queued.comments.map((c: { id: number }) => c.id),
      [root.id, reply.id],
    );
    // ... and that read marked the artifact as watched.
    assert.equal(store.watch.get(loopArtifact.id)?.label, "agent");

    // Resolving takes it out of the queue; un-sending does too.
    const resolved = await creatorApi(env, "PATCH", "local-publisher-token", {
      id: root.id,
      resolved: true,
    });
    assert.equal(resolved.status, 200);
    const after = await creatorApi(
      env,
      "GET",
      "local-publisher-token",
      undefined,
      "?status=sent",
    );
    assert.equal((await after.json()).count, 0);
    const unsent = await widget(env, "PATCH", await viewerToken(env), {
      id: root.id,
      sent_to_agent: false,
    });
    assert.equal((await unsent.json()).comment.sent_to_agent_at, null);
    assert.equal(root.sent_to_agent_at, null);
    // Un-sending is not an event.
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("long-poll answers as soon as a newer comment lands and times out cleanly", async () => {
  const { store, env } = fresh();
  let clock = 1_800_000_000_000;
  const sleeps: number[] = [];
  let landed: { created_at: number } | null = null;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
    if (sleeps.length === 2)
      landed = seedComment(store, {
        artifact_id: loopArtifact.id,
        body: "New feedback",
        created_at: Math.floor(clock / 1000),
      });
  };
  const result = await waitForComments(
    env,
    loopArtifact,
    { since: 1_799_999_999 },
    25,
    { sleep, nowMs: () => clock },
  );
  assert.equal(result.count, 1);
  assert.equal(result.comments[0]!.body, "New feedback");
  // Two idle checks, then the settle pause so the burst second is complete.
  assert.deepEqual(sleeps, [2000, 2000, 1100]);
  assert.equal(result.next_since, landed!.created_at);
  assert.equal(result.has_more, false);

  // Timeout: three checks over five seconds, an empty page, and a cursor
  // that never passes the second still in progress.
  const idle = fresh();
  let clock2 = 1_800_000_100_000;
  const sleeps2: number[] = [];
  const empty = await waitForComments(idle.env, loopArtifact, { since: 1 }, 5, {
    sleep: async (ms) => {
      sleeps2.push(ms);
      clock2 += ms;
    },
    nowMs: () => clock2,
  });
  assert.equal(empty.count, 0);
  assert.deepEqual(sleeps2, [2000, 2000, 1000]);
  assert.equal(empty.next_since, Math.floor(clock2 / 1000) - 1);

  assert.equal(clampWait("99"), LONG_POLL_MAX_SEC);
  assert.equal(clampWait("abc"), 0);
  assert.equal(clampWait("-3"), 0);
  assert.equal(clampWait("7.9"), 7);
});

test("both comment routes accept wait and return next_since; an already-newer comment answers at once", async () => {
  const { store, env } = fresh();
  const now = nowSec();
  seedComment(store, {
    artifact_id: loopArtifact.id,
    body: "already here",
    created_at: now - 5,
  });
  const started = Date.now();
  const viewer = await widget(
    env,
    "GET",
    await viewerToken(env),
    undefined,
    `?artifact_key=${KEY}&since=${now - 10}&wait=25`,
  );
  const body = await viewer.json();
  assert.equal(body.count, 1);
  assert.equal(body.next_since, now - 5);
  assert.ok(Date.now() - started < 1500, "answered without waiting");

  const creator = await creatorApi(
    env,
    "GET",
    "local-publisher-token",
    undefined,
    `?since=${now - 10}&wait=25&status=open`,
  );
  const creatorBody = await creator.json();
  assert.equal(creatorBody.count, 1);
  assert.equal(creatorBody.next_since, now - 5);

  // Without wait the response still carries the cursor.
  const plain = await creatorApi(env, "GET", "local-publisher-token");
  assert.equal(typeof (await plain.json()).next_since, "number");
});
