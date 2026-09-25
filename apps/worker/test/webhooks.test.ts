import assert from "node:assert/strict";
import test from "node:test";
import { signViewerSession } from "../src/auth.ts";
import { retryWebhookDeliveries } from "../src/maintenance.ts";
import { handleComments } from "../src/serve.ts";
import type { Artifact, Env } from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import {
  attemptDelivery,
  handleWebhooksApi,
  MAX_ATTEMPTS,
  normalizeWebhookUrl,
  RETRY_BACKOFF_SEC,
  signWebhookBody,
  WEBHOOK_EVENTS,
  type DeliveryRow,
} from "../src/webhooks.ts";
import {
  loopArtifact,
  newStore,
  seedWebhook,
  storeEnv,
  type Store,
} from "./helpers/comment-store.ts";

const ORIGIN = "https://artifacts.example.com";
const NOW = 1_800_000_000;

const otherArtifact: Artifact = {
  ...loopArtifact,
  id: "art_other",
  slug: "other",
  url_key: "other-zzz999",
};

function delivery(store: Store, webhookId: string, attempts = 0): DeliveryRow {
  const row: DeliveryRow = {
    id: `dlv_${store.deliveries.length + 1}`,
    webhook_id: webhookId,
    event: "comment.created",
    payload_json: JSON.stringify({ event: "comment.created", n: 1 }),
    attempts,
    next_attempt_at: NOW,
    delivered_at: null,
    last_status: null,
    last_error: null,
    created_at: NOW,
  };
  store.deliveries.push(row);
  return row;
}

const fetchStatus =
  (status: number, calls: { url: string; init: RequestInit }[] = []) =>
  async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : "{}", { status });
  };

test("webhook URLs must be public https, like upstream backends", () => {
  const env = storeEnv(newStore([]));
  const ok = [
    "https://hooks.example.com/au",
    "https://hooks.example.com/au?token=abc",
    "https://sub.domain.example.org:8443/x",
  ];
  for (const url of ok) assert.equal(normalizeWebhookUrl(url, env), url, url);
  const bad = [
    "http://hooks.example.com/au",
    "https://user:pw@hooks.example.com/",
    "https://hooks.example.com/#frag",
    "https://10.0.0.1/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://svc.internal/hook",
    "https://box.local/hook",
    "https://nodots/hook",
    "https://artifacts.example.com/api/v1/webhooks",
    "not a url",
    "",
  ];
  for (const url of bad)
    assert.equal(normalizeWebhookUrl(url, env), null, url || "(empty)");
});

test("a delivery is signed with the secret, carries the event and delivery ids, and is marked delivered on 2xx", async () => {
  const store = newStore([loopArtifact]);
  const env = storeEnv(store);
  const hook = seedWebhook(store, {
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/au",
    secret: "whsec_abc",
  });
  const row = delivery(store, hook.id);
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await attemptDelivery(env, row, hook, {
    fetch: fetchStatus(204, calls),
    now: () => NOW,
  });
  assert.deepEqual(result, {
    ok: true,
    status: 204,
    error: null,
    attempts: 1,
    next_attempt_at: null,
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, hook.url);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal instanceof AbortSignal);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Artifact-Use-Event"), "comment.created");
  assert.equal(headers.get("X-Artifact-Use-Delivery"), row.id);
  assert.equal(
    headers.get("X-Artifact-Use-Signature"),
    await signWebhookBody("whsec_abc", row.payload_json),
  );
  assert.equal(init.body, row.payload_json);
  // A receiver verifies by recomputing the HMAC over the raw body.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("whsec_abc"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(row.payload_json),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(headers.get("X-Artifact-Use-Signature"), `sha256=${expected}`);
  const stored = store.deliveries[0]!;
  assert.equal(stored.delivered_at, NOW);
  assert.equal(stored.attempts, 1);
  assert.equal(stored.next_attempt_at, null);
  assert.equal(stored.last_status, 204);
  assert.equal(hook.last_delivery_at, NOW);
  assert.equal(hook.last_status, 204);
});

test("a failing receiver walks the backoff ladder (1m, 5m, 30m, 2h, 12h) and is then dropped", async () => {
  const store = newStore([loopArtifact]);
  const env = storeEnv(store);
  const hook = seedWebhook(store, {
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/au",
  });
  const row = delivery(store, hook.id);
  const expected = [...RETRY_BACKOFF_SEC.map((s) => NOW + s), null];
  assert.equal(expected.length, MAX_ATTEMPTS);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attemptDelivery(env, row, hook, {
      fetch: fetchStatus(500),
      now: () => NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, i + 1);
    assert.equal(result.next_attempt_at, expected[i], `attempt ${i + 1}`);
    assert.equal(result.error, "receiver answered 500");
    assert.equal(store.deliveries[0]!.next_attempt_at, expected[i]);
    assert.equal(store.deliveries[0]!.delivered_at, null);
  }
  // A redirect is a failure too: the signed body is never bounced elsewhere.
  const bounced = delivery(store, hook.id);
  const redirect = await attemptDelivery(env, bounced, hook, {
    fetch: fetchStatus(302),
    now: () => NOW,
  });
  assert.equal(redirect.ok, false);
  assert.equal(redirect.status, 302);
  // Timeouts and network failures record why.
  const dead = delivery(store, hook.id);
  const timedOut = await attemptDelivery(env, dead, hook, {
    fetch: async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    },
    timeoutMs: 10,
    now: () => NOW,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.status, null);
  assert.match(String(timedOut.error), /timed out after 10ms/);
  assert.equal(timedOut.next_attempt_at, NOW + 60);
});

test("the cron retries only due deliveries and drops those of revoked webhooks", async () => {
  const store = newStore([loopArtifact]);
  const env = storeEnv(store);
  const live = seedWebhook(store, {
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/live",
  });
  const revoked = seedWebhook(store, {
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/gone",
    revoked_at: NOW - 10,
  });
  const due = delivery(store, live.id, 2);
  due.next_attempt_at = NOW - 1;
  const later = delivery(store, live.id, 1);
  later.next_attempt_at = NOW + 100;
  const done = delivery(store, live.id, 1);
  done.delivered_at = NOW - 50;
  const orphan = delivery(store, revoked.id);
  orphan.next_attempt_at = NOW - 5;
  const calls: { url: string; init: RequestInit }[] = [];
  const report = await retryWebhookDeliveries(env, NOW, {
    fetch: fetchStatus(200, calls),
  });
  assert.deepEqual(report, { attempted: 1, delivered: 1, dropped: 1 });
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://hooks.example.com/live"],
  );
  assert.equal(due.delivered_at, NOW);
  assert.equal(due.attempts, 3);
  assert.equal(later.next_attempt_at, NOW + 100);
  assert.equal(later.attempts, 1);
  assert.equal(orphan.next_attempt_at, null);
  assert.equal(orphan.delivered_at, null);
});

test("POST /api/v1/webhooks validates, returns the secret once; GET lists without it; DELETE revokes", async () => {
  const store = newStore([loopArtifact]);
  const env = storeEnv(store);
  const call = (method: string, path: string, body?: unknown) =>
    handleWebhooksApi(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: "Bearer local-publisher-token",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      path,
    );
  const created = await call("POST", "/api/v1/webhooks", {
    url: "https://hooks.example.com/au",
    artifact: loopArtifact.url_key,
    events: ["comment.created", "comment.sent_to_agent"],
  });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.match(body.webhook.id, /^whk_/);
  assert.match(body.webhook.secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(body.webhook.artifact, loopArtifact.url_key);
  assert.deepEqual(body.webhook.events, [
    "comment.created",
    "comment.sent_to_agent",
  ]);
  assert.equal(store.webhooks[0]!.artifact_id, loopArtifact.id);
  assert.equal(store.webhooks[0]!.secret, body.webhook.secret);

  // Org-wide with a chosen secret and default events.
  const orgWide = await call("POST", "/api/v1/webhooks", {
    url: "https://hooks.example.com/all",
    secret: "my-shared-secret",
  });
  const orgBody = await orgWide.json();
  assert.equal(orgBody.webhook.artifact, null);
  assert.equal(orgBody.webhook.secret, "my-shared-secret");
  assert.deepEqual(orgBody.webhook.events, [...WEBHOOK_EVENTS]);

  const badUrl = await call("POST", "/api/v1/webhooks", {
    url: "http://hooks.example.com/au",
  });
  assert.equal(badUrl.status, 400);
  assert.equal((await badUrl.json()).error.code, "invalid_webhook_url");
  const badEvents = await call("POST", "/api/v1/webhooks", {
    url: "https://hooks.example.com/au",
    events: ["comment.deleted"],
  });
  assert.equal(badEvents.status, 400);
  assert.equal((await badEvents.json()).error.code, "invalid_webhook_events");
  const badSecret = await call("POST", "/api/v1/webhooks", {
    url: "https://hooks.example.com/au",
    secret: "short",
  });
  assert.equal((await badSecret.json()).error.code, "invalid_webhook_secret");
  const missing = await call("POST", "/api/v1/webhooks", {
    url: "https://hooks.example.com/au",
    artifact: "nope-000000",
  });
  assert.equal(missing.status, 404);

  const listed = await call("GET", "/api/v1/webhooks");
  const list = await listed.json();
  assert.deepEqual(list.events, [...WEBHOOK_EVENTS]);
  assert.equal(list.webhooks.length, 2);
  for (const hook of list.webhooks) {
    assert.equal("secret" in hook, false);
    assert.equal(hook.pending, 0);
  }
  assert.equal(list.webhooks[0].artifact, loopArtifact.url_key);

  const gone = await call("DELETE", `/api/v1/webhooks/${body.webhook.id}`);
  assert.deepEqual(await gone.json(), { ok: true, revoked: body.webhook.id });
  assert.ok(store.webhooks[0]!.revoked_at);
  const again = await call("DELETE", `/api/v1/webhooks/${body.webhook.id}`);
  assert.equal(again.status, 404);
  assert.equal((await call("GET", "/api/v1/webhooks")).status, 200);
  assert.equal(
    (
      (await (await call("GET", "/api/v1/webhooks")).json()) as {
        webhooks: unknown[];
      }
    ).webhooks.length,
    1,
  );

  // No credential, no webhooks.
  const anon = await handleWebhooksApi(
    new Request(`${ORIGIN}/api/v1/webhooks`),
    env,
    "/api/v1/webhooks",
  );
  assert.equal(anon.status, 401);
});

test("comment.created fans out only to subscriptions that cover the artifact and the event", async () => {
  const store = newStore([loopArtifact, otherArtifact]);
  const env = storeEnv(store);
  seedWebhook(store, {
    id: "whk_org",
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/org",
  });
  seedWebhook(store, {
    id: "whk_this",
    org_id: loopArtifact.org_id,
    artifact_id: loopArtifact.id,
    url: "https://hooks.example.com/this",
  });
  seedWebhook(store, {
    id: "whk_other",
    org_id: loopArtifact.org_id,
    artifact_id: otherArtifact.id,
    url: "https://hooks.example.com/other",
  });
  seedWebhook(store, {
    id: "whk_resolved_only",
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/resolved",
    events_json: JSON.stringify(["comment.resolved"]),
  });
  seedWebhook(store, {
    id: "whk_revoked",
    org_id: loopArtifact.org_id,
    url: "https://hooks.example.com/revoked",
    revoked_at: 5,
  });
  seedWebhook(store, {
    id: "whk_foreign_org",
    org_id: "org_someone_else",
    url: "https://hooks.example.com/foreign",
  });
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(
      `${String(url)} ${new Headers(init?.headers).get("X-Artifact-Use-Event")}`,
    );
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const token = await signViewerSession(
      {
        artifact_id: loopArtifact.id,
        version_id: "ver_loop",
        email: "reviewer@example.com",
        verified: false,
        view_id: 3,
        exp: nowSec() + 600,
      },
      env,
    );
    const post = (body: unknown) =>
      handleComments(
        new Request(`${ORIGIN}/_au/comments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ artifact_key: loopArtifact.url_key, ...body }),
        }),
        env,
        "/_au/comments",
      );
    const root = await post({ body: "Please enlarge the legend" });
    assert.equal(root.status, 200);
    const rootId = (await root.json()).comment.id;
    assert.deepEqual(calls.sort(), [
      "https://hooks.example.com/org comment.created",
      "https://hooks.example.com/this comment.created",
    ]);
    calls.length = 0;
    const reply = await post({ body: "Done", parent_id: rootId });
    assert.equal(reply.status, 200);
    assert.deepEqual(calls.sort(), [
      "https://hooks.example.com/org comment.replied",
      "https://hooks.example.com/this comment.replied",
    ]);
    const replyPayload = JSON.parse(
      store.deliveries.find((d) => d.event === "comment.replied")!.payload_json,
    );
    assert.equal(replyPayload.comment.parent_comment_id, rootId);
    assert.equal(replyPayload.thread.id, rootId);
    assert.equal(replyPayload.thread.body, "Please enlarge the legend");
    calls.length = 0;
    const resolved = await handleComments(
      new Request(`${ORIGIN}/_au/comments`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          artifact_key: loopArtifact.url_key,
          id: rootId,
          resolved: true,
        }),
      }),
      env,
      "/_au/comments",
    );
    assert.equal(resolved.status, 200);
    assert.deepEqual(calls.sort(), [
      "https://hooks.example.com/org comment.resolved",
      "https://hooks.example.com/resolved comment.resolved",
      "https://hooks.example.com/this comment.resolved",
    ]);
    assert.ok(store.deliveries.every((d) => d.delivered_at !== null));
  } finally {
    globalThis.fetch = realFetch;
  }
});
