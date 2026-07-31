import assert from "node:assert/strict";
import test from "node:test";
import {
  issueAdminCsrfToken,
  signPayload,
  verifyPayload,
} from "../src/auth.ts";
import { handleAdminUiApi, handlePublisherAdmin } from "../src/publisher.ts";
import type { Env, PublisherSession } from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const EXP = nowSec() + 3 * 86400;

function switchEnv(
  memberships: Array<{ org_id: string; role?: string }> = [],
): Env {
  return {
    SESSION_SECRET: "workspace-switch-secret",
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    DB: {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          async first() {
            if (sql.includes("workspace_membership_sync"))
              return { refreshed_at: nowSec() };
            return null;
          },
          async all() {
            if (sql.includes("FROM workspace_memberships"))
              return {
                results: memberships.map((row) => ({
                  org_name: "Workspace",
                  org_slug: "workspace",
                  role: "member",
                  ...row,
                })),
              };
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
}

async function rawSession(
  env: Env,
  overrides: Partial<PublisherSession> = {},
): Promise<string> {
  return signPayload(
    {
      typ: "publisher",
      sub: "user_switch",
      orgId: "org_a",
      email: "switcher@example.com",
      name: "Switcher",
      role: "admin",
      roles: ["admin"],
      permissions: ["team:manage"],
      sessionId: "session_workos",
      exp: EXP,
      ...overrides,
    } satisfies PublisherSession,
    env,
  );
}

function switchRequest(
  raw: string | null,
  org: string,
  headers: Record<string, string> = {},
): Request {
  const all = new Headers({
    Accept: "text/html",
    "Sec-Fetch-Site": "same-origin",
    ...headers,
  });
  if (raw) all.set("Cookie", `au_pub=${encodeURIComponent(raw)}`);
  return new Request(
    `https://artifacts.example.com/admin/switch?org=${encodeURIComponent(org)}`,
    { headers: all },
  );
}

async function mintedSession(
  env: Env,
  response: Response,
): Promise<PublisherSession | null> {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("au_pub="));
  if (!cookie) return null;
  const raw = decodeURIComponent(/^au_pub=([^;]+)/.exec(cookie)?.[1] || "");
  return verifyPayload<PublisherSession>(raw, env);
}

test("switching to a snapshot workspace re-mints the session in place", async () => {
  const env = switchEnv([{ org_id: "org_b", role: "member" }]);
  const response = await handlePublisherAdmin(
    switchRequest(await rawSession(env), "org_b"),
    env,
    "/admin/switch",
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/admin");
  const session = await mintedSession(env, response);
  assert.ok(session);
  assert.equal(session.orgId, "org_b");
  assert.equal(session.sub, "user_switch");
  assert.equal(session.sessionId, "session_workos");
  assert.equal(session.exp, EXP);
});

test("the target's snapshot role replaces the old org's role and permissions", async () => {
  for (const [snapshotRole, expected] of [
    ["member", "member"],
    ["admin", "admin"],
    ["", "member"],
  ] as const) {
    const env = switchEnv([{ org_id: "org_b", role: snapshotRole }]);
    const response = await handlePublisherAdmin(
      switchRequest(await rawSession(env), "org_b"),
      env,
      "/admin/switch",
    );
    const session = await mintedSession(env, response);
    assert.equal(session?.role, expected, snapshotRole);
    assert.deepEqual(session?.roles, [expected], snapshotRole);
    assert.deepEqual(session?.permissions, [], snapshotRole);
  }
});

test("a target outside the snapshot falls back to the OAuth flow", async () => {
  const env = switchEnv([{ org_id: "org_b" }]);
  const response = await handlePublisherAdmin(
    switchRequest(await rawSession(env), "org_c"),
    env,
    "/admin/switch",
  );
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "/login?organization_id=org_c",
  );
  assert.equal(await mintedSession(env, response), null);
});

test("cross-site navigations and same-org targets change nothing", async () => {
  const env = switchEnv([{ org_id: "org_b" }]);
  const crossSite = await handlePublisherAdmin(
    switchRequest(await rawSession(env), "org_b", {
      "Sec-Fetch-Site": "cross-site",
    }),
    env,
    "/admin/switch",
  );
  assert.equal(crossSite.status, 302);
  assert.equal(crossSite.headers.get("Location"), "/admin");
  assert.equal(await mintedSession(env, crossSite), null);

  const sameOrg = await handlePublisherAdmin(
    switchRequest(await rawSession(env), "org_a"),
    env,
    "/admin/switch",
  );
  assert.equal(sameOrg.status, 302);
  assert.equal(sameOrg.headers.get("Location"), "/admin");
  assert.equal(await mintedSession(env, sameOrg), null);
});

test("a malformed org id is rejected before any lookup", async () => {
  const env = switchEnv();
  const response = await handlePublisherAdmin(
    switchRequest(await rawSession(env), "not-an-org"),
    env,
    "/admin/switch",
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_workspace");
});

test("workspace-context advertises the in-place switch URL", async () => {
  const env = switchEnv([{ org_id: "org_a" }, { org_id: "org_b" }]);
  const raw = await rawSession(env);
  const csrf = await issueAdminCsrfToken(raw, EXP, env);
  const response = await handleAdminUiApi(
    new Request("https://artifacts.example.com/admin/api/workspace-context", {
      headers: {
        Accept: "application/json",
        Cookie: `au_pub=${encodeURIComponent(raw)}; au_admin_csrf=${encodeURIComponent(csrf.token)}`,
        "X-CSRF-Token": csrf.token,
      },
    }),
    env,
    "/admin/api/workspace-context",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    workspaces: Array<{ org_id: string; switch_url: string | null }>;
  };
  const other = body.workspaces.find((row) => row.org_id === "org_b");
  assert.equal(other?.switch_url, "/admin/switch?org=org_b");
  const active = body.workspaces.find((row) => row.org_id === "org_a");
  assert.equal(active?.switch_url, null);
});
