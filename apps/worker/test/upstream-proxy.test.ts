import assert from "node:assert/strict";
import test from "node:test";
import { signPayload } from "../src/auth.ts";
import worker from "../src/index.ts";
import { servePublic } from "../src/serve.ts";
import { normalizeUpstreamUrl } from "../src/upstream.ts";
import type {
  Artifact,
  ArtifactUpstream,
  Env,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const ORIGIN = "https://artifacts.example.com";
const ARTIFACT_PATH = "/go/console-demo-abc123/";
const UPSTREAM = "https://backend.example.net/base";

function artifactRow(gateLevel: Artifact["gate_level"] = "email"): Artifact {
  return {
    id: "art_console",
    org_id: "org_console",
    slug: "console-demo",
    url_key: "console-demo-abc123",
    title: "Console demo",
    description: null,
    gate_level: gateLevel,
    allowlist_json: null,
    current_version_id: "ver_console",
    created_by: "user_console",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
}

function upstreamRow(secret: string | null = "s3cret"): ArtifactUpstream {
  return {
    artifact_id: "art_console",
    base_url: UPSTREAM,
    secret,
    created_by: "user_console",
    created_at: 1,
    updated_at: 1,
  };
}

function fakeEnv(artifact: Artifact, upstream: ArtifactUpstream | null) {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM artifact_upstreams")) return upstream;
          if (sql.includes("rate_counters")) return { count: 1 };
          if (sql.includes("FROM artifacts")) return artifact;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return {
    DB: db,
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "upstream-proxy-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
  } as unknown as Env;
}

async function viewerCookie(env: Env, email = "Viewer@Example.com") {
  const session: ViewerSession = {
    artifact_id: "art_console",
    version_id: "ver_console",
    email: email.toLowerCase(),
    verified: false,
    view_id: 42,
    exp: nowSec() + 600,
  };
  return `au_art_console=${encodeURIComponent(await signPayload(session, env))}`;
}

type Captured = { url: string; init: RequestInit & { headers: Headers } };

function stubFetch(
  respond: (captured: Captured) => Response | Promise<Response>,
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const captured = {
      url: String(input),
      init: { ...(init || {}), headers: new Headers(init?.headers) },
    };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("without a viewer session the upstream path answers the JSON gate, even for browsers", async () => {
  const env = fakeEnv(artifactRow(), upstreamRow());
  const stub = stubFetch(() => new Response("nope"));
  try {
    const response = await servePublic(
      new Request(`${ORIGIN}${ARTIFACT_PATH}_api/api/referrals`, {
        headers: { Accept: "text/html" },
      }),
      env,
      `${ARTIFACT_PATH}_api/api/referrals`,
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("Content-Type") || "", /json/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("a gated viewer's request is forwarded with the secret and gate identity", async () => {
  const env = fakeEnv(artifactRow(), upstreamRow());
  const stub = stubFetch(
    () =>
      new Response('{"ok":true}', {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "backend=leak; Path=/",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=600",
        },
      }),
  );
  try {
    const path = `${ARTIFACT_PATH}_api/api/referrals/abc/action`;
    const response = await servePublic(
      new Request(`${ORIGIN}${path}?warm=1`, {
        method: "POST",
        headers: {
          Cookie: await viewerCookie(env),
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.7",
          "X-Ui-Key": "should-not-forward",
        },
        body: '{"type":"retry"}',
      }),
      env,
      path,
    );
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, `${UPSTREAM}/api/referrals/abc/action?warm=1`);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.get("Authorization"), "Bearer s3cret");
    assert.equal(
      call.init.headers.get("X-Artifact-Viewer-Email"),
      "viewer@example.com",
    );
    assert.equal(call.init.headers.get("X-Artifact-Viewer-Verified"), "0");
    assert.equal(
      call.init.headers.get("X-Artifact-Key"),
      "console-demo-abc123",
    );
    assert.equal(call.init.headers.get("X-Forwarded-For"), "203.0.113.7");
    assert.equal(call.init.headers.get("Content-Type"), "application/json");
    assert.equal(call.init.headers.get("X-Ui-Key"), null);
    assert.equal(call.init.headers.get("Cookie"), null);
    assert.equal(
      new TextDecoder().decode(call.init.body as ArrayBuffer),
      '{"type":"retry"}',
    );
  } finally {
    stub.restore();
  }
});

test("an artifact without an upstream keeps 404ing its _api path", async () => {
  const env = fakeEnv(artifactRow(), null);
  const stub = stubFetch(() => new Response("nope"));
  try {
    const response = await servePublic(
      new Request(`${ORIGIN}${ARTIFACT_PATH}_api/anything`, {
        headers: { Cookie: await viewerCookie(env) },
      }),
      env,
      `${ARTIFACT_PATH}_api/anything`,
    );
    assert.equal(response.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("an unreachable upstream is a 502, not a worker exception", async () => {
  const env = fakeEnv(artifactRow(), upstreamRow());
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const response = await servePublic(
      new Request(`${ORIGIN}${ARTIFACT_PATH}_api/healthz`, {
        headers: { Cookie: await viewerCookie(env) },
      }),
      env,
      `${ARTIFACT_PATH}_api/healthz`,
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "upstream_unreachable");
  } finally {
    stub.restore();
  }
});

test("the router lets write methods through to the upstream path only", async () => {
  const env = fakeEnv(artifactRow(), upstreamRow());
  const stub = stubFetch(() => new Response("ok", { status: 200 }));
  try {
    const cookie = await viewerCookie(env);
    const proxied = await worker.fetch(
      new Request(`${ORIGIN}${ARTIFACT_PATH}_api/api/demo/reset`, {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    assert.equal(proxied.status, 200);
    assert.equal(stub.calls.length, 1);
    const blocked = await worker.fetch(
      new Request(`${ORIGIN}${ARTIFACT_PATH}index.html`, {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    assert.equal(blocked.status, 405);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("the email gate sends the viewer back to the URL they asked for, query included", async () => {
  const env = fakeEnv(artifactRow(), null);
  const response = await servePublic(
    new Request(`${ORIGIN}${ARTIFACT_PATH}?skin=mti&v=share_1&au_sso=1`, {
      headers: { Accept: "text/html" },
    }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(
    body,
    /name="redirect_to" value="\/go\/console-demo-abc123\/\?skin=mti"/,
  );
});

test("upstream URLs are limited to public https hosts", () => {
  const env = fakeEnv(artifactRow(), null);
  assert.equal(
    normalizeUpstreamUrl("https://backend.example.net/base/", env),
    "https://backend.example.net/base",
  );
  assert.equal(
    normalizeUpstreamUrl("https://Backend.Example.net", env),
    "https://backend.example.net",
  );
  for (const bad of [
    "",
    "http://backend.example.net",
    "https://10.0.0.5/api",
    "https://[::1]/api",
    "https://localhost/api",
    "https://svc.cluster.local/api",
    "https://metadata.google.internal/api",
    "https://user:pw@backend.example.net",
    "https://backend.example.net/?x=1",
    "https://backend.example.net/#frag",
    "https://artifacts.example.com/go/other-abc123/",
    "not a url",
  ])
    assert.equal(normalizeUpstreamUrl(bad, env), null, bad);
});
