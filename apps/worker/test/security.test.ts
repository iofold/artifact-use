import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as adminApi from "../../admin-ui/src/api.ts";
import type { Env, PublisherSession } from "../src/types.ts";
import * as auth from "../src/auth.ts";
import { handleConnectApi } from "../src/connect.ts";
import worker from "../src/index.ts";
import {
  handleAdminUiApi,
  handlePublisherAdmin,
  renderHome,
} from "../src/publisher.ts";
import * as util from "../src/util.ts";

const env = { SESSION_SECRET: "csrf-test-secret" } as Env;

test("system security headers cover every admin response", () => {
  assert.equal(
    typeof util.secureSystemResponse,
    "function",
    "a central response wrapper must enforce headers independently of render helpers",
  );

  const response = util.secureSystemResponse(
    "/admin/api/missing",
    new Response('{"error":"missing"}', {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    "frame-ancestors 'none'",
  );
  assert.equal(
    response.headers.get("Cross-Origin-Opener-Policy"),
    "same-origin",
  );
});

test("central admin protection leaves artifact responses embeddable", () => {
  assert.equal(typeof util.secureSystemResponse, "function");

  const artifact = new Response("artifact");
  const response = util.secureSystemResponse(
    "/go/demo-123/index.html",
    artifact,
  );

  assert.equal(response, artifact);
  assert.equal(response.headers.get("X-Frame-Options"), null);
  assert.equal(response.headers.get("Content-Security-Policy"), null);
});

test("shared HTML pages carry the system security headers", () => {
  const response = util.htmlPage("Gate", "<p>Continue</p>");

  for (const [name, value] of Object.entries(util.SYSTEM_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
});

test("admin CSRF token is signed, session-bound, and double submitted", async () => {
  assert.equal(
    typeof auth.issueAdminCsrfToken,
    "function",
    "admin shells must be able to issue a session-bound token",
  );
  assert.equal(typeof auth.verifyAdminCsrf, "function");

  const rawSession = "signed-publisher-session-a";
  const issued = await auth.issueAdminCsrfToken(
    rawSession,
    util.nowSec() + 600,
    env,
  );

  assert.match(issued.cookie, /^au_admin_csrf=/);
  assert.match(issued.cookie, /; Path=\/admin(?:;|$)/);
  assert.match(issued.cookie, /; Secure(?:;|$)/);
  assert.match(issued.cookie, /; SameSite=Strict(?:;|$)/);
  assert.doesNotMatch(issued.cookie, /HttpOnly/i);

  const valid = csrfRequest(issued.token, issued.token);
  assert.equal(await auth.verifyAdminCsrf(valid, rawSession, env), true);

  const missingHeader = csrfRequest(issued.token, null);
  assert.equal(
    await auth.verifyAdminCsrf(missingHeader, rawSession, env),
    false,
  );

  const copiedToAnotherSession = csrfRequest(issued.token, issued.token);
  assert.equal(
    await auth.verifyAdminCsrf(
      copiedToAnotherSession,
      "signed-publisher-session-b",
      env,
    ),
    false,
  );
});

test("admin CSRF rejects expired and cross-type signed payloads", async () => {
  assert.equal(typeof auth.verifyAdminCsrf, "function");
  const rawSession = "signed-publisher-session-a";
  const sessionHash = await util.sha256Hex(rawSession);

  for (const payload of [
    {
      typ: "admin_csrf",
      session_hash: sessionHash,
      nonce: "expired",
      exp: util.nowSec() - 1,
    },
    {
      typ: "viewer",
      session_hash: sessionHash,
      nonce: "wrong-type",
      exp: util.nowSec() + 600,
    },
  ]) {
    const token = await auth.signPayload(payload, env);
    assert.equal(
      await auth.verifyAdminCsrf(csrfRequest(token, token), rawSession, env),
      false,
    );
  }
});

function csrfRequest(cookieToken: string, headerToken: string | null): Request {
  const headers = new Headers({
    Cookie: `au_admin_csrf=${encodeURIComponent(cookieToken)}`,
  });
  if (headerToken) headers.set("X-CSRF-Token", headerToken);
  return new Request("https://artifacts.example.com/admin/api/overview", {
    headers,
  });
}

test("admin SPA sends its path-scoped CSRF cookie on reads and writes", async () => {
  assert.equal(typeof adminApi.adminCsrfToken, "function");
  assert.equal(
    adminApi.adminCsrfToken(
      "other=x; au_admin_csrf=signed%2Etoken%3D; final=y",
    ),
    "signed.token=",
  );

  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  Object.assign(globalThis, {
    document: { cookie: "au_admin_csrf=csrf-token" },
    window: { location: { href: "" } },
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    await adminApi.api.overview();
    await adminApi.api.mintPrompt("test", "1");
    assert.equal(typeof adminApi.api.approveConnect, "function");
    await adminApi.api.approveConnect("ABCD-2345");
    await adminApi.postForm("/admin/agent-token/revoke", { id: "crt_test" });
  } finally {
    Object.assign(globalThis, {
      fetch: originalFetch,
      document: originalDocument,
      window: originalWindow,
    });
  }

  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "/admin/api/overview",
      "/admin/api/agent-prompt",
      "/admin/api/connect/approve",
      "/admin/agent-token/revoke",
    ],
  );
  for (const { init } of calls) {
    assert.equal(new Headers(init?.headers).get("X-CSRF-Token"), "csrf-token");
  }
});

test("admin handlers reject missing CSRF before any database access", async () => {
  let dbCalls = 0;
  const testEnv = {
    SESSION_SECRET: env.SESSION_SECRET,
    SITE_BASE_URL: "https://artifacts.example.com",
    DB: {
      prepare: () => {
        dbCalls += 1;
        return {
          bind() {
            return this;
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
  const rawSession = await publisherSession(testEnv);

  for (const [path, init] of [
    ["/admin/api/overview", {}],
    [
      "/admin/api/agent-prompt",
      { method: "POST", body: JSON.stringify({ label: "attacker" }) },
    ],
    [
      "/admin/api/connect/approve",
      { method: "POST", body: JSON.stringify({ code: "ABCD-2345" }) },
    ],
  ] satisfies Array<[string, RequestInit]>) {
    const response = await handleAdminUiApi(
      publisherRequest(path, rawSession, init),
      testEnv,
      path,
    );
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, "csrf_failed", path);
  }

  for (const path of [
    "/admin/super/transfer",
    "/admin/artifact/access",
    "/admin/artifact/share-link",
    "/admin/artifact/share-link/revoke",
    "/admin/agent-token/revoke",
    "/admin/team/invite",
    "/admin/team/invite/revoke",
  ]) {
    const response = await handlePublisherAdmin(
      publisherRequest(path, rawSession, {
        method: "POST",
        body: new URLSearchParams({ id: "crt_test" }),
      }),
      testEnv,
      path,
    );
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, "csrf_failed", path);
  }
  assert.equal(dbCalls, 0);
});

test("authenticated admin shell issues CSRF without rendering it", async () => {
  const testEnv = {
    SESSION_SECRET: env.SESSION_SECRET,
    SITE_BASE_URL: "https://artifacts.example.com",
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><div id=root></div>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
  } as unknown as Env;
  const rawSession = await publisherSession(testEnv);
  const response = await handlePublisherAdmin(
    publisherRequest("/admin/connect?code=ABCD-2345", rawSession, {
      headers: { Accept: "text/html" },
    }),
    testEnv,
    "/admin/connect",
  );

  assert.equal(response.status, 200);
  const csrfCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("au_admin_csrf="));
  assert.ok(csrfCookie);
  const token = decodeURIComponent(
    /^au_admin_csrf=([^;]+)/.exec(csrfCookie)?.[1] || "",
  );
  assert.ok(token);
  assert.doesNotMatch(await response.text(), new RegExp(escapeRegExp(token)));
});

test("legacy admin API and connect approval surfaces are inert", async () => {
  const testEnv = {
    SESSION_SECRET: env.SESSION_SECRET,
    SITE_BASE_URL: "https://artifacts.example.com",
  } as Env;

  const retired = await worker.fetch(
    new Request("https://artifacts.example.com/api/admin/overview", {
      headers: { Accept: "application/json" },
    }),
    testEnv,
  );
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error.code, "admin_api_retired");

  const legacyGet = await worker.fetch(
    new Request("https://artifacts.example.com/connect?code=ABCD-2345"),
    testEnv,
  );
  assert.equal(legacyGet.status, 302);
  assert.equal(
    legacyGet.headers.get("Location"),
    "/admin/connect?code=ABCD-2345",
  );

  const legacyPost = await worker.fetch(
    new Request("https://artifacts.example.com/connect", { method: "POST" }),
    testEnv,
  );
  assert.equal(legacyPost.status, 405);
});

async function publisherSession(testEnv: Env): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_test",
    orgId: "org_test",
    email: "owner@example.com",
    name: "Owner",
    exp: util.nowSec() + 600,
  };
  return auth.signPayload(session, testEnv);
}

function publisherRequest(
  path: string,
  rawSession: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `au_pub=${encodeURIComponent(rawSession)}`);
  headers.set("Accept", headers.get("Accept") || "application/json");
  return new Request(`https://artifacts.example.com${path}`, {
    ...init,
    headers,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("device connect advertises only the protected admin approval URL", async () => {
  const testEnv = {
    SITE_BASE_URL: "https://artifacts.example.com",
    DB: {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        async first() {
          return sql.includes("INSERT INTO rate_counters")
            ? { count: 1 }
            : null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      }),
    },
  } as unknown as Env;
  const response = await handleConnectApi(
    new Request("https://artifacts.example.com/api/v1/connect/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"agent_label":"test agent"}',
    }),
    testEnv,
    "/api/v1/connect/start",
  );
  const body = (await response.json()) as { verification_url: string };
  assert.match(
    body.verification_url,
    /^https:\/\/artifacts\.example\.com\/admin\/connect\?code=/,
  );

  const home = await (
    await renderHome(new Request("https://artifacts.example.com/"), testEnv)
  ).text();
  assert.match(home, /\/admin\/connect/);
  assert.doesNotMatch(
    home,
    /human approves the code at https:\/\/artifacts\.example\.com\/connect/,
  );

  for (const file of [
    "README.md",
    "docs/MCP.md",
    "docs/site/index.html",
    "skills/artifact-use/SKILL.md",
    "plugins/codex/artifact-use/skills/artifact-use/SKILL.md",
  ]) {
    const contents = await readFile(file, "utf8");
    assert.doesNotMatch(
      contents,
      /(?:at |or |href=["'])\/?connect(?:\?code)?(?:["'`)\s])/,
      `${file} still advertises the legacy approval page`,
    );
  }
});
