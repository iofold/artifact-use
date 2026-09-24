import assert from "node:assert/strict";
import test from "node:test";
import {
  proxyUpstream,
  UPSTREAM_VIEWER_LIMIT_PER_MIN,
} from "../src/upstream.ts";
import type {
  Artifact,
  ArtifactUpstream,
  Env,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const ORIGIN = "https://artifacts.example.com";

function artifactRow(gateLevel: Artifact["gate_level"]): Artifact {
  return {
    id: "art_guard",
    org_id: "org_guard",
    slug: "guard",
    url_key: "guard-abc123",
    title: "Guarded",
    description: null,
    gate_level: gateLevel,
    allowlist_json: null,
    current_version_id: "ver_guard",
    created_by: "user_guard",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
}

const upstream: ArtifactUpstream = {
  artifact_id: "art_guard",
  base_url: "https://backend.example.net",
  secret: "s3cret",
  created_by: "user_guard",
  created_at: 1,
  updated_at: 1,
};

// The fake counter returns the same count for every bucket; tests set it to
// model "under" and "over" the per-viewer limit.
function fakeEnv(artifact: Artifact, counter: { count: number }): Env {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM artifact_upstreams")) return upstream;
          if (sql.includes("rate_counters")) return { count: counter.count };
          if (sql.includes("FROM artifacts")) return artifact;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return {
    DB: db,
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "upstream-guard-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
  } as unknown as Env;
}

const session: ViewerSession = {
  artifact_id: "art_guard",
  version_id: "ver_guard",
  email: "viewer@example.com",
  verified: false,
  view_id: 7,
  exp: nowSec() + 600,
};

function stubFetch(): { calls: number; restore: () => void } {
  const state = { calls: 0, restore: () => {} };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    state.calls += 1;
    return new Response("ok");
  }) as typeof fetch;
  state.restore = () => (globalThis.fetch = original);
  return state;
}

test("a public artifact never reaches its upstream", async () => {
  const stub = stubFetch();
  try {
    const response = await proxyUpstream(
      new Request(`${ORIGIN}/go/guard-abc123/_api/anything`),
      fakeEnv(artifactRow("public"), { count: 1 }),
      artifactRow("public"),
      session,
      ["anything"],
    );
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "upstream_requires_gate");
    assert.equal(stub.calls, 0);
  } finally {
    stub.restore();
  }
});

test("a viewer over the per-minute ceiling gets 429 with Retry-After", async () => {
  const stub = stubFetch();
  try {
    const under = await proxyUpstream(
      new Request(`${ORIGIN}/go/guard-abc123/_api/items`),
      fakeEnv(artifactRow("email"), { count: UPSTREAM_VIEWER_LIMIT_PER_MIN }),
      artifactRow("email"),
      session,
      ["items"],
    );
    assert.equal(under.status, 200);
    assert.equal(stub.calls, 1);

    const over = await proxyUpstream(
      new Request(`${ORIGIN}/go/guard-abc123/_api/items`),
      fakeEnv(artifactRow("email"), {
        count: UPSTREAM_VIEWER_LIMIT_PER_MIN + 1,
      }),
      artifactRow("email"),
      session,
      ["items"],
    );
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get("Retry-After")) >= 1);
    const body = (await over.json()) as { error: { code: string } };
    assert.equal(body.error.code, "upstream_rate_limited");
    assert.equal(stub.calls, 1);
  } finally {
    stub.restore();
  }
});
