import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { handleMcp } from "../src/mcp.ts";
import type { Artifact, Env } from "../src/types.ts";

const artifact = {
  id: "art_del",
  org_id: "org_del",
  slug: "delete-demo",
  url_key: "delete-demo-abc123",
  title: "Delete demo",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_del",
  created_by: "user_del",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

const prefix = `orgs/${artifact.org_id}/artifacts/${artifact.id}/`;
// A file left under a previous org's prefix by a workspace transfer: only the
// artifact_files storage_key knows about it, the prefix sweep cannot find it.
const transferredKey = `orgs/org_prev/artifacts/${artifact.id}/versions/ver_0/files/index.html`;
const currentKey = `${prefix}versions/ver_del/files/index.html`;
const leftoverKey = `${prefix}versions/ver_del/uploads/upl_x/stray.bin`;

test("DELETE purges storage keys, swept leftovers, and all rows", async () => {
  const state = deleteEnv(artifact);
  const response = await handleAdminApi(
    deleteRequest(),
    state.env,
    `/api/v1/artifacts/${artifact.url_key}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    deleted: artifact.url_key,
  });
  assert.deepEqual(
    [...state.deletedKeys].sort(),
    [transferredKey, currentKey, leftoverKey].sort(),
  );
  const batched = state.batchedSql;
  assert.ok(batched[0].includes("DELETE FROM artifact_files"));
  assert.equal(
    batched[batched.length - 1],
    "DELETE FROM artifacts WHERE id = ?",
  );
  for (const table of [
    "artifact_versions",
    "comments",
    "viewer_tokens",
    "views",
    "share_links",
    "legacy_artifact_paths",
  ]) {
    assert.ok(
      batched.some((sql) => sql.includes(`DELETE FROM ${table}`)),
      table,
    );
  }
});

test("DELETE outside the caller's workspace is a 404 and touches nothing", async () => {
  const state = deleteEnv({ ...artifact, org_id: "org_other" });
  const response = await handleAdminApi(
    deleteRequest(),
    state.env,
    `/api/v1/artifacts/${artifact.url_key}`,
  );
  assert.equal(response.status, 404);
  assert.equal(state.deletedKeys.length, 0);
  assert.equal(state.batchedSql.length, 0);
});

test("mcp delete refuses to run without confirm: true", async () => {
  const state = deleteEnv(artifact);
  const response = await handleMcp(mcpDeleteRequest({}), state.env);
  const body = (await response.json()) as { error?: { message?: string } };
  assert.ok(body.error?.message?.includes("confirm: true"));
  assert.equal(state.deletedKeys.length, 0);
  assert.equal(state.batchedSql.length, 0);
});

test("mcp delete with confirm: true deletes end to end", async () => {
  const state = deleteEnv(artifact);
  const response = await handleMcp(
    mcpDeleteRequest({ confirm: true }),
    state.env,
  );
  const body = (await response.json()) as {
    result?: { structuredContent?: { ok?: boolean } };
  };
  assert.equal(body.result?.structuredContent?.ok, true);
  assert.equal(state.deletedKeys.length, 3);
  assert.ok(state.batchedSql.includes("DELETE FROM artifacts WHERE id = ?"));
});

function deleteRequest(): Request {
  return new Request(
    `https://artifacts.example.com/api/v1/artifacts/${artifact.url_key}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer local-publisher-token" },
    },
  );
}

function mcpDeleteRequest(extra: Record<string, unknown>): Request {
  return new Request("https://artifacts.example.com/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer local-publisher-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "artifact_manage",
        arguments: { action: "delete", artifact: artifact.url_key, ...extra },
      },
    }),
  });
}

function deleteEnv(row: Artifact): {
  env: Env;
  deletedKeys: string[];
  batchedSql: string[];
} {
  const state = { deletedKeys: [] as string[], batchedSql: [] as string[] };
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        bind: () => statement,
        async first() {
          if (sql.includes("FROM artifacts")) return row;
          return null;
        },
        async all() {
          if (sql.includes("storage_key"))
            return {
              results: [
                { storage_key: transferredKey },
                { storage_key: currentKey },
              ],
            };
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: { sql: string }[]) {
      state.batchedSql.push(...statements.map((statement) => statement.sql));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const bucket = {
    async list(options: { prefix: string; cursor?: string }) {
      assert.equal(options.prefix, prefix);
      if (!options.cursor)
        return {
          objects: [{ key: currentKey }],
          truncated: true,
          cursor: "page-2",
        };
      return { objects: [{ key: leftoverKey }], truncated: false };
    },
    async delete(keys: string[]) {
      state.deletedKeys.push(...keys);
    },
  };
  return {
    env: {
      DB: db,
      BUCKET: bucket,
      SESSION_SECRET: "artifact-delete-secret",
      SITE_BASE_URL: "https://artifacts.example.com",
      ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
      DEV_AUTH_TOKEN: "local-publisher-token",
      DEV_AUTH_USER_ID: "user_del",
      DEV_AUTH_ORG_ID: artifact.org_id,
      DEV_AUTH_EMAIL: "publisher@example.com",
    } as unknown as Env,
    get deletedKeys() {
      return state.deletedKeys;
    },
    get batchedSql() {
      return state.batchedSql;
    },
  };
}
