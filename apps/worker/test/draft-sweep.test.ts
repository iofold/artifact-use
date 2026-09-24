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
