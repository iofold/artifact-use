import assert from "node:assert/strict";
import test from "node:test";
import { signPayload } from "../src/auth.ts";
import { handleArtifactContext } from "../src/serve.ts";
import type { Artifact, Env, PublisherSession } from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const artifact = {
  id: "art_ctx",
  org_id: "org_ctx",
  slug: "ctx-demo",
  url_key: "ctx-demo-abc123",
  title: "Context demo",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_ctx",
  created_by: "user_ctx",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

function ctxEnv(row: Artifact | null): Env {
  return {
    SESSION_SECRET: "artifact-context-secret",
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
  } as unknown as Env;
}

async function publisherCookie(env: Env, orgId: string): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_ctx",
    orgId,
    email: "owner@example.com",
    name: "Owner",
    exp: nowSec() + 600,
  };
  return signPayload(session, env);
}

function contextRequest(cookie?: string, referer?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", `au_pub=${encodeURIComponent(cookie)}`);
  if (referer) headers.set("Referer", referer);
  return new Request(
    "https://artifacts.example.com/_au/artifact-context?artifact_key=ctx-demo-abc123",
    { headers },
  );
}

test("publishers of the artifact's org get the admin deep link", async () => {
  const env = ctxEnv(artifact);
  const cookie = await publisherCookie(env, "org_ctx");
  const res = await handleArtifactContext(contextRequest(cookie), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    role: "publisher",
    admin_url: "/admin?open=art_ctx",
  });
  assert.match(String(res.headers.get("Cache-Control")), /no-store/);
});

test("everyone else gets the identical minimal viewer response", async () => {
  const env = ctxEnv(artifact);
  const otherOrg = await handleArtifactContext(
    contextRequest(await publisherCookie(env, "org_other")),
    env,
  );
  const anonymous = await handleArtifactContext(contextRequest(), env);
  const otherBody = await otherOrg.text();
  assert.equal(otherBody, await anonymous.text());
  assert.deepEqual(JSON.parse(otherBody), { role: "viewer" });
});

test("suspended artifacts answer viewer even for their owner", async () => {
  for (const suspended of [
    { ...artifact, status: "suspended" },
    { ...artifact, org_suspended: 1 },
  ]) {
    const env = ctxEnv(suspended as Artifact);
    const res = await handleArtifactContext(
      contextRequest(await publisherCookie(env, "org_ctx")),
      env,
    );
    assert.deepEqual(await res.json(), { role: "viewer" });
  }
});

test("a page can only ask about the artifact it is serving", async () => {
  const env = ctxEnv(artifact);
  const cookie = await publisherCookie(env, "org_ctx");
  const foreignPage = await handleArtifactContext(
    contextRequest(
      cookie,
      "https://artifacts.example.com/go/other-artifact-zzz999/",
    ),
    env,
  );
  assert.deepEqual(await foreignPage.json(), { role: "viewer" });
  const ownPage = await handleArtifactContext(
    contextRequest(
      cookie,
      "https://artifacts.example.com/go/ctx-demo-abc123/reports.html",
    ),
    env,
  );
  assert.equal((await ownPage.json()).role, "publisher");
});

test("the response never carries capability or identity fields", async () => {
  const env = ctxEnv(artifact);
  const res = await handleArtifactContext(
    contextRequest(await publisherCookie(env, "org_ctx")),
    env,
  );
  const raw = await res.text();
  for (const needle of ["share", "token", "email", "stats", "allowlist"])
    assert.ok(!raw.includes(needle), `response leaks "${needle}"`);
});

test("non-GET methods are rejected", async () => {
  const env = ctxEnv(artifact);
  const res = await handleArtifactContext(
    new Request(
      "https://artifacts.example.com/_au/artifact-context?artifact_key=ctx-demo-abc123",
      { method: "POST" },
    ),
    env,
  );
  assert.equal(res.status, 405);
});
