import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/types.ts";

// Multi-workspace credentials: org-scoped tokens stay pinned, user-scoped
// tokens select a membership-validated workspace per request through the
// D1 snapshot of WorkOS memberships.

const USER = "user_01TESTUSER0000000000000000";
const HOME_ORG = "org_01HOME000000000000000000000";
const OTHER_ORG = "org_01OTHER00000000000000000000";

test("org-scoped token behaves exactly as before without a workspace header", async () => {
  const { auth, env } = await setup();
  const minted = await auth.mintCreatorToken(env, mintInput());
  const creator = await auth.getCreator(request(minted.token), env);
  assert.ok(creator);
  assert.equal(creator.orgId, HOME_ORG);
  assert.equal(creator.tokenScope, "org");
  assert.equal(Boolean(creator.workspaceSelected), false);
});

test("org-scoped token may name its own workspace but no other", async () => {
  const { auth, env } = await setup();
  const minted = await auth.mintCreatorToken(env, mintInput());
  const own = await auth.getCreator(request(minted.token, HOME_ORG), env);
  assert.equal(own?.orgId, HOME_ORG);
  assert.equal(own?.workspaceSelected, true);

  const response = await auth.safeCreator(
    request(minted.token, OTHER_ORG),
    env,
  );
  assert.ok(response instanceof Response);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "workspace_forbidden");
});

test("user-scoped token requires a workspace on strict routes and not on lax ones", async () => {
  const { auth, env } = await setup();
  const minted = await auth.mintCreatorToken(env, mintInput({ scope: "user" }));

  const strict = await auth.safeCreator(request(minted.token), env);
  assert.ok(strict instanceof Response);
  assert.equal(strict.status, 400);
  assert.equal((await strict.json()).error.code, "workspace_required");

  const lax = await auth.getCreator(request(minted.token), env, {
    laxWorkspace: true,
  });
  assert.equal(lax?.orgId, HOME_ORG);
  assert.equal(lax?.tokenScope, "user");
});

test("user-scoped token resolves a workspace slug through WorkOS and then the cache", async () => {
  const { auth, env, state } = await setup({
    workos: [
      { org_id: HOME_ORG, name: "Iofold Labs" },
      { org_id: OTHER_ORG, name: "Milestone Internet" },
    ],
  });
  const minted = await auth.mintCreatorToken(env, mintInput({ scope: "user" }));

  const bySlug = await auth.getCreator(
    request(minted.token, "milestone-internet"),
    env,
  );
  assert.equal(bySlug?.orgId, OTHER_ORG);
  assert.equal(bySlug?.workspaceSelected, true);
  const fetchesAfterFirst = state.workosCalls;
  assert.ok(fetchesAfterFirst > 0);

  // Fresh snapshot: the second selection must not consult WorkOS again.
  const byId = await auth.getCreator(request(minted.token, HOME_ORG), env);
  assert.equal(byId?.orgId, HOME_ORG);
  assert.equal(state.workosCalls, fetchesAfterFirst);
});

test("an unknown workspace on a fresh snapshot is refused without re-querying WorkOS", async () => {
  const { auth, env, state } = await setup({
    workos: [{ org_id: HOME_ORG, name: "Iofold Labs" }],
  });
  seedCache(state, [
    { org_id: HOME_ORG, org_name: "Iofold Labs", org_slug: "iofold-labs" },
  ]);
  const minted = await auth.mintCreatorToken(env, mintInput({ scope: "user" }));

  const refused = await auth.safeCreator(
    request(minted.token, "someone-elses-workspace"),
    env,
  );
  assert.ok(refused instanceof Response);
  assert.equal(refused.status, 403);
  assert.equal(state.workosCalls, 0);
});

test("a membership that ended is refused after the snapshot goes stale", async () => {
  const { auth, env, state } = await setup({ workos: [] });
  seedCache(
    state,
    [
      {
        org_id: OTHER_ORG,
        org_name: "Milestone Internet",
        org_slug: "milestone-internet",
      },
    ],
    // Stale snapshot: older than the positive TTL, so WorkOS is re-queried
    // and now reports no memberships at all.
    Math.floor(Date.now() / 1000) - 3600,
  );
  const minted = await auth.mintCreatorToken(env, mintInput({ scope: "user" }));

  const refused = await auth.safeCreator(
    request(minted.token, OTHER_ORG),
    env,
  );
  assert.ok(refused instanceof Response);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "workspace_forbidden");
  assert.ok(state.workosCalls > 0);
  assert.equal(state.memberships.get(USER)?.length || 0, 0);
});

test("GET /api/v1/workspaces lists memberships with slugs for a lax credential", async () => {
  const { env, auth, state } = await setup({
    workos: [
      { org_id: HOME_ORG, name: "Iofold Labs" },
      { org_id: OTHER_ORG, name: "Milestone Internet" },
    ],
  });
  const admin = await import("../src/admin.ts");
  const minted = await auth.mintCreatorToken(env, mintInput({ scope: "user" }));

  const response = await admin.handleAdminApi(
    request(minted.token, "", "/api/v1/workspaces", "GET"),
    env,
    "/api/v1/workspaces",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token_scope, "user");
  assert.deepEqual(
    body.workspaces
      .map((row: { org_slug: string }) => row.org_slug)
      .sort(),
    ["iofold-labs", "milestone-internet"],
  );
  assert.ok(state.workosCalls > 0);
});

function mintInput(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER,
    orgId: HOME_ORG,
    email: "yash@example.com",
    label: "workspace test",
    source: "admin" as const,
    expiresDays: 7,
    ...overrides,
  };
}

function request(
  token: string,
  workspace = "",
  path = "/api/v1/publish/start",
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (workspace) headers["X-Artifact-Use-Workspace"] = workspace;
  return new Request(`https://artifacts.example${path}`, { method, headers });
}

interface FakeState {
  tokens: Map<string, Record<string, unknown>>;
  memberships: Map<
    string,
    Array<{ org_id: string; org_name: string; org_slug: string; role: string }>
  >;
  sync: Map<string, number>;
  workosCalls: number;
}

function seedCache(
  state: FakeState,
  rows: Array<{ org_id: string; org_name: string; org_slug: string }>,
  refreshedAt = Math.floor(Date.now() / 1000),
): void {
  state.memberships.set(
    USER,
    rows.map((row) => ({ ...row, role: "member" })),
  );
  state.sync.set(USER, refreshedAt);
}

async function setup(
  opts: { workos?: Array<{ org_id: string; name: string }> } = {},
): Promise<{
  auth: typeof import("../src/auth.ts");
  env: Env;
  state: FakeState;
}> {
  const auth = await import("../src/auth.ts");
  const state: FakeState = {
    tokens: new Map(),
    memberships: new Map(),
    sync: new Map(),
    workosCalls: 0,
  };
  const workosOrgs = opts.workos || [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("https://api.workos.com")) {
      return realFetch(input as never);
    }
    state.workosCalls += 1;
    if (url.includes("/user_management/organization_memberships")) {
      return jsonResponse({
        data: workosOrgs.map((org) => ({
          id: `om_${org.org_id}`,
          user_id: USER,
          organization_id: org.org_id,
          status: "active",
          role: { slug: "member" },
        })),
        list_metadata: {},
      });
    }
    const orgMatch = url.match(/\/organizations\/([^/?]+)$/);
    if (orgMatch) {
      const org = workosOrgs.find(
        (candidate) => candidate.org_id === decodeURIComponent(orgMatch[1]!),
      );
      if (!org)
        return jsonResponse({ message: "not found" }, 404);
      return jsonResponse({ id: org.org_id, name: org.name });
    }
    return jsonResponse({ message: "unexpected workos path" }, 500);
  }) as typeof fetch;
  test.after(() => {
    globalThis.fetch = realFetch;
  });

  const env = {
    SESSION_SECRET: "workspace-test-secret",
    WORKOS_API_KEY: "sk_test",
    SITE_BASE_URL: "https://artifacts.example",
    DB: fakeDb(state),
  } as unknown as Env;
  return { auth, env, state };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A minimal D1 stand-in covering exactly the statements the workspace flow
// prepares. Unknown SQL throws so schema drift fails loudly here.
function fakeDb(state: FakeState): unknown {
  function statement(sql: string, params: unknown[]) {
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      async first(): Promise<unknown> {
        if (/SELECT revoked_at FROM creator_tokens/.test(sql)) {
          const row = state.tokens.get(String(params[0]));
          return row ? { revoked_at: row.revoked_at ?? null } : null;
        }
        if (/SELECT refreshed_at FROM workspace_membership_sync/.test(sql)) {
          const at = state.sync.get(String(params[0]));
          return at === undefined ? null : { refreshed_at: at };
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
      async all(): Promise<{ results: unknown[] }> {
        if (/FROM workspace_memberships/.test(sql)) {
          return { results: state.memberships.get(String(params[0])) || [] };
        }
        throw new Error(`unexpected all(): ${sql}`);
      },
      async run(): Promise<{ meta: { changes: number } }> {
        if (/INSERT INTO creator_tokens/.test(sql)) {
          state.tokens.set(String(params[0]), {
            id: params[0],
            org_id: params[1],
            user_id: params[2],
            label: params[3],
            source: params[4],
            scope: params[5],
            created_at: params[6],
            expires_at: params[7],
            revoked_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM workspace_memberships/.test(sql)) {
          state.memberships.delete(String(params[0]));
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO workspace_memberships/.test(sql)) {
          const rows = state.memberships.get(String(params[0])) || [];
          rows.push({
            org_id: String(params[1]),
            org_name: String(params[2]),
            org_slug: String(params[3]),
            role: String(params[4]),
          });
          state.memberships.set(String(params[0]), rows);
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO workspace_membership_sync/.test(sql)) {
          state.sync.set(String(params[0]), Number(params[1]));
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run(): ${sql}`);
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const prepared of statements) await prepared.run();
      return [];
    },
  };
}
