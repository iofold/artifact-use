import assert from "node:assert/strict";
import test from "node:test";
import {
  ABANDONED_AFTER_SEC,
  sweepAbandonedUploads,
} from "../src/maintenance.ts";
import type { Artifact, ArtifactVersion, Env } from "../src/types.ts";

const NOW = 1_800_000_000;

const oldDraft: ArtifactVersion = {
  id: "ver_old",
  artifact_id: "art_shell",
  org_id: "org_x",
  status: "draft",
  entrypoint: "index.html",
  manifest_json: null,
  total_size: 0,
  file_count: 0,
  created_by: "user_x",
  created_at: NOW - ABANDONED_AFTER_SEC - 60,
  completed_at: null,
};

const shell: Artifact = {
  id: "art_shell",
  org_id: "org_x",
  slug: "shell",
  url_key: "shell-abc123",
  title: "Discarded",
  description: null,
  gate_level: "email",
  allowlist_json: null,
  current_version_id: null,
  created_by: "user_x",
  created_at: NOW - ABANDONED_AFTER_SEC - 60,
  updated_at: NOW - ABANDONED_AFTER_SEC - 60,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
};

function fakeEnv() {
  const deleted: string[] = [];
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes("status IN ('draft', 'finalizing')"))
            return { results: [oldDraft] };
          if (sql.includes("current_version_id IS NULL"))
            return { results: [shell] };
          if (sql.includes("FROM artifact_files WHERE version_id"))
            return { results: [{ storage_key: "k/listed-in-d1" }] };
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(list: unknown[]) {
      statements.push(...list.map(() => "batch"));
      return [];
    },
  };
  const bucket = {
    async list(opts: { prefix: string }) {
      return {
        objects: [{ key: `${opts.prefix}orphan.bin` }],
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  const env = { DB: db, BUCKET: bucket } as unknown as Env;
  return { env, deleted, statements };
}

test("old drafts are purged from D1 and R2, then the empty shell artifact goes", async () => {
  const { env, deleted, statements } = fakeEnv();
  const report = await sweepAbandonedUploads(env, NOW);
  assert.deepEqual(report, { drafts: 1, files: 2, artifacts: 1 });
  assert.ok(deleted.includes("k/listed-in-d1"));
  assert.ok(
    deleted.some((key) =>
      key.startsWith("orgs/org_x/artifacts/art_shell/versions/ver_old/"),
    ),
  );
  // one batch for the version purge, one for the artifact delete
  assert.equal(statements.length, 2 + 9);
});

test("stale pending connect requests are marked expired by the sweep", async () => {
  const { expireStaleConnectRequests } = await import("../src/maintenance.ts");
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const make = (params: unknown[]) => ({
          bind: (...next: unknown[]) => make(next),
          async run() {
            seen.push({ sql, params });
            return { meta: { changes: 9 } };
          },
        });
        return make([]);
      },
    },
  } as unknown as Env;
  const changed = await expireStaleConnectRequests(env, NOW);
  assert.equal(changed, 9);
  assert.match(
    seen[0]?.sql || "",
    /SET status = 'expired' WHERE status = 'pending'/,
  );
  assert.equal(seen[0]?.params[0], NOW);
});

test("file hashes are backfilled from R2 for rows that lack one", async () => {
  const { backfillFileHashes } = await import("../src/maintenance.ts");
  const updates: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const make = (params: unknown[]) => ({
          bind: (...next: unknown[]) => make(next),
          async all() {
            if (sql.includes("sha256 IS NULL ORDER BY"))
              return {
                results: [
                  {
                    version_id: "ver_a",
                    path: "index.html",
                    storage_key: "k/a",
                  },
                  {
                    version_id: "ver_b",
                    path: "gone.html",
                    storage_key: "k/gone",
                  },
                ],
              };
            return { results: [] };
          },
          async run() {
            if (sql.includes("UPDATE artifact_files SET sha256"))
              updates.push(params);
            return { meta: { changes: 1 } };
          },
        });
        return make([]);
      },
    },
    BUCKET: {
      async get(key: string) {
        if (key !== "k/a") return null;
        return {
          arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        };
      },
    },
  } as unknown as Env;
  const report = await backfillFileHashes(env, 10);
  assert.deepEqual(report, { hashed: 1, missing: 1 });
  assert.equal(updates.length, 1);
  // sha256("hello")
  assert.equal(
    updates[0]?.[0],
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.equal(updates[0]?.[1], "ver_a");
});
