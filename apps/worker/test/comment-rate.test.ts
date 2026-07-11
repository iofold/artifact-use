import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { handleComments } from "../src/serve.ts";
import type { Artifact, Env } from "../src/types.ts";

const artifact = {
  id: "art_comments",
  org_id: "org_comments",
  slug: "comment-demo",
  url_key: "comment-demo-abc123",
  title: "Comment demo",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_comments",
  created_by: "user_comments",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

test("viewer and creator comment writes share the identity limit", async () => {
  for (const surface of ["viewer", "creator"] as const) {
    for (const method of ["POST", "PATCH"] as const) {
      const state = commentEnv((bucket) =>
        bucket.startsWith("comments:identity:10m:") ? 31 : 1,
      );
      const response = await commentRequest(surface, method, state.env);
      assert.equal(response.status, 429, `${surface} ${method}`);
      assert.equal((await response.json()).error.code, "rate_limited");
      assert.ok(Number(response.headers.get("Retry-After")) > 0);
      assert.equal(state.commentMutations, 0);
      assert.ok(
        state.rateBuckets.some((bucket) =>
          bucket.startsWith("comments:identity:10m:"),
        ),
      );
      assert.ok(
        state.rateBuckets.every(
          (bucket) =>
            !bucket.includes("publisher@example.com") &&
            !bucket.includes("203.0.113.80"),
        ),
      );
    }
  }
});

test("comment writes enforce the independent IP limit", async () => {
  const state = commentEnv((bucket) =>
    bucket.startsWith("comments:ip:hour:") ? 61 : 1,
  );
  const response = await commentRequest("viewer", "POST", state.env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "rate_limited");
  assert.equal(state.commentMutations, 0);
  assert.deepEqual(
    state.rateBuckets.map((bucket) => bucket.split(":").slice(0, 3).join(":")),
    ["comments:identity:10m", "comments:ip:hour"],
  );
});

async function commentRequest(
  surface: "viewer" | "creator",
  method: "POST" | "PATCH",
  env: Env,
): Promise<Response> {
  const isViewer = surface === "viewer";
  const path = isViewer
    ? "/_au/comments"
    : `/api/v1/artifacts/${artifact.url_key}/comments`;
  const body =
    method === "POST"
      ? {
          ...(isViewer ? { artifact_key: artifact.url_key } : {}),
          body: "Please improve this section",
        }
      : {
          ...(isViewer ? { artifact_key: artifact.url_key } : {}),
          id: 1,
          resolved: true,
        };
  const request = new Request(`https://artifacts.example.com${path}`, {
    method,
    headers: {
      Authorization: "Bearer local-publisher-token",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.80",
    },
    body: JSON.stringify(body),
  });
  return isViewer
    ? handleComments(request, env, path)
    : handleAdminApi(request, env, path);
}

function commentEnv(rateCount: (bucket: string) => number): {
  env: Env;
  rateBuckets: string[];
  commentMutations: number;
} {
  const state = { rateBuckets: [] as string[], commentMutations: 0 };
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("INSERT INTO rate_counters")) {
            const bucket = String(statement.values[0] || "");
            state.rateBuckets.push(bucket);
            return { count: rateCount(bucket) };
          }
          if (sql.includes("FROM artifacts")) return artifact;
          if (sql.includes("SELECT id FROM comments")) return { id: 1 };
          return null;
        },
        async run() {
          if (
            sql.includes("INSERT INTO comments") ||
            sql.includes("UPDATE comments SET")
          )
            state.commentMutations += 1;
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
  };
  return {
    env: {
      DB: db,
      SESSION_SECRET: "comment-rate-secret",
      SITE_BASE_URL: "https://artifacts.example.com",
      ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
      DEV_AUTH_TOKEN: "local-publisher-token",
      DEV_AUTH_USER_ID: "user_comments",
      DEV_AUTH_ORG_ID: artifact.org_id,
      DEV_AUTH_EMAIL: "publisher@example.com",
    } as unknown as Env,
    get rateBuckets() {
      return state.rateBuckets;
    },
    get commentMutations() {
      return state.commentMutations;
    },
  };
}
