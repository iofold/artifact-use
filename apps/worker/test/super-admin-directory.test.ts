import assert from "node:assert/strict";
import test from "node:test";
import * as publisher from "../src/publisher.ts";
import type { Env } from "../src/types.ts";
import * as workos from "../src/workos.ts";

test("super admin directory includes empty workspaces and multi-workspace users", () => {
  const buildSuperDirectory = (
    publisher as unknown as {
      buildSuperDirectory?: (input: Record<string, unknown>) => {
        users: Array<Record<string, unknown>>;
        workspaces: Array<Record<string, unknown>>;
      };
    }
  ).buildSuperDirectory;
  assert.equal(
    typeof buildSuperDirectory,
    "function",
    "publisher must expose the directory reconciliation used by Super Admin",
  );

  const result = buildSuperDirectory!({
    users: [
      {
        id: "user_owner",
        email: "owner@example.com",
        first_name: "Own",
        last_name: "Er",
        created_at: "2026-07-01T00:00:00.000Z",
        last_sign_in_at: "2026-07-16T12:00:00.000Z",
        email_verified: true,
      },
      {
        id: "user_collaborator",
        email: "collaborator@example.com",
        first_name: "Collab",
        last_name: "Orator",
        created_at: "2026-07-02T00:00:00.000Z",
        last_sign_in_at: null,
        email_verified: true,
      },
    ],
    organizations: [
      {
        id: "org_personal",
        name: "Owner workspace",
        created_at: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "org_shared",
        name: "Shared workspace",
        created_at: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "org_empty",
        name: "No artifacts yet",
        created_at: "2026-07-03T00:00:00.000Z",
      },
    ],
    memberships: [
      {
        id: "om_personal",
        user_id: "user_owner",
        organization_id: "org_personal",
        status: "active",
        role: { slug: "admin" },
      },
      {
        id: "om_shared_owner",
        user_id: "user_owner",
        organization_id: "org_shared",
        status: "active",
        role: { slug: "member" },
      },
      {
        id: "om_shared_collaborator",
        user_id: "user_collaborator",
        organization_id: "org_shared",
        status: "active",
        role: { slug: "admin" },
      },
    ],
    activity: [
      {
        org_id: "org_personal",
        user_id: "user_owner",
        artifacts: 2,
        views: 17,
        comments: 3,
      },
      {
        org_id: "org_legacy",
        user_id: "user_deleted",
        artifacts: 1,
        views: 4,
        comments: 0,
      },
    ],
    tokens: [
      {
        org_id: "org_shared",
        user_id: "user_owner",
        tokens: 2,
        active_tokens: 1,
      },
      {
        org_id: "org_legacy",
        user_id: "user_deleted",
        tokens: 1,
        active_tokens: 1,
      },
    ],
  });

  assert.deepEqual(
    result.workspaces.map((workspace) => workspace.id),
    ["org_personal", "org_shared", "org_empty", "org_legacy"],
    "WorkOS workspaces with no artifacts and D1-only legacy workspaces remain visible",
  );
  assert.equal(
    result.workspaces.find((workspace) => workspace.id === "org_empty")
      ?.artifacts,
    0,
  );
  assert.equal(
    result.workspaces.find((workspace) => workspace.id === "org_shared")
      ?.member_count,
    2,
  );
  assert.equal(
    result.workspaces.find((workspace) => workspace.id === "org_legacy")
      ?.directory_status,
    "orphaned",
  );

  const owner = result.users.find((user) => user.id === "user_owner");
  assert.deepEqual(owner?.workspace_ids, ["org_personal", "org_shared"]);
  assert.equal(owner?.artifacts, 2);
  assert.equal(owner?.active_tokens, 1);

  const deleted = result.users.find((user) => user.id === "user_deleted");
  assert.equal(deleted?.directory_status, "orphaned");
  assert.deepEqual(deleted?.workspace_ids, ["org_legacy"]);
});

test("WorkOS directory listing follows pagination for users and organizations", async () => {
  const listWorkosDirectory = (
    workos as unknown as {
      listWorkosDirectory?: (env: Env) => Promise<{
        users: Array<Record<string, unknown>>;
        organizations: Array<Record<string, unknown>>;
        memberships: Array<Record<string, unknown>>;
      }>;
    }
  ).listWorkosDirectory;
  assert.equal(
    typeof listWorkosDirectory,
    "function",
    "WorkOS module must provide a paginated directory listing",
  );

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    requests.push(`${url.pathname}${url.search}`);
    const after = url.searchParams.get("after");
    let body: Record<string, unknown>;
    if (url.pathname === "/user_management/users") {
      body = after
        ? {
            data: [{ id: "user_2", email: "two@example.com" }],
            list_metadata: {},
          }
        : {
            data: [{ id: "user_1", email: "one@example.com" }],
            list_metadata: { after: "users_page_2" },
          };
    } else if (url.pathname === "/organizations") {
      body = after
        ? {
            data: [{ id: "org_2", name: "Two" }],
            list_metadata: {},
          }
        : {
            data: [{ id: "org_1", name: "One" }],
            list_metadata: { after: "orgs_page_2" },
          };
    } else if (url.pathname === "/user_management/organization_memberships") {
      body = {
        data: [
          {
            id: `om_${url.searchParams.get("organization_id")}`,
            user_id: "user_1",
            organization_id: url.searchParams.get("organization_id"),
            status: "active",
          },
        ],
        list_metadata: {},
      };
    } else {
      return new Response("not found", { status: 404 });
    }
    return Response.json(body);
  }) as typeof fetch;

  try {
    const directory = await listWorkosDirectory!({
      WORKOS_API_KEY: "sk_test_directory",
    } as Env);
    assert.deepEqual(
      directory.users.map((user) => user.id),
      ["user_1", "user_2"],
    );
    assert.deepEqual(
      directory.organizations.map((organization) => organization.id),
      ["org_1", "org_2"],
    );
    assert.equal(directory.memberships.length, 2);
    assert.ok(
      requests.includes("/user_management/users?limit=100&after=users_page_2"),
    );
    assert.ok(requests.includes("/organizations?limit=100&after=orgs_page_2"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
