import assert from "node:assert/strict";
import test from "node:test";
import { servePublic } from "../src/serve.ts";
import type { Artifact, ArtifactVersion, Env } from "../src/types.ts";

const ORIGIN = "https://artifacts.example.com";

const artifact: Artifact = {
  id: "art_pub",
  org_id: "org_pub",
  slug: "pub",
  url_key: "pub-abc123",
  title: "Public page",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_pub",
  created_by: "user_pub",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
};

const version: ArtifactVersion = {
  id: "ver_pub",
  artifact_id: "art_pub",
  org_id: "org_pub",
  status: "complete",
  entrypoint: "index.html",
  manifest_json: null,
  total_size: 10,
  file_count: 1,
  created_by: "user_pub",
  created_at: 1,
  completed_at: 1,
};

function fakeEnv(): Env {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("FROM artifact_versions")) return version;
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
    SESSION_SECRET: "reserved-paths-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
  } as unknown as Env;
}

// A page that links `_au/comments` relative to its own URL used to surface the
// path validator's throw as `500 internal_error` to real viewers.
test("reserved or malformed segments under an artifact URL are 404, not 500", async () => {
  for (const suffix of ["_au/comments", "_iof/state.json", "cdn-cgi/rum"]) {
    const path = `/go/pub-abc123/${suffix}`;
    const response = await servePublic(
      new Request(`${ORIGIN}${path}`),
      fakeEnv(),
      path,
    );
    assert.equal(response.status, 404, suffix);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "file_not_found", suffix);
  }
});
