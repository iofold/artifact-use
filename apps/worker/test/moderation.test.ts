import assert from "node:assert/strict";
import test from "node:test";
import { issueAdminCsrfToken, signPayload } from "../src/auth.ts";
import { handleGateRoute } from "../src/gate.ts";
import { handlePublish } from "../src/publish.ts";
import { handlePublisherAdmin } from "../src/publisher.ts";
import { handleAgentToken, handleComments, servePublic } from "../src/serve.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
  PublisherSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const artifact = {
  id: "art_test",
  org_id: "org_test",
  slug: "demo",
  url_key: "demo-abc123",
  title: "Private internal title",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_test",
  created_by: "user_test",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

test("shared moderation policy detects artifact and organization suspension", async () => {
  const moderation = await import("../src/moderation.ts").catch(() => ({}));
  assert.equal(
    typeof moderation.isArtifactUnavailable,
    "function",
    "moderation must have one shared availability predicate",
  );

  assert.equal(moderation.isArtifactUnavailable(artifact), false);
  assert.equal(
    moderation.isArtifactUnavailable({ ...artifact, status: "suspended" }),
    true,
  );
  assert.equal(
    moderation.isArtifactUnavailable({ ...artifact, org_suspended: 1 }),
    true,
  );
});

test("public suspension response is generic for browsers and agents", async () => {
  const moderation = await import("../src/moderation.ts").catch(() => ({}));
  assert.equal(typeof moderation.artifactUnavailableResponse, "function");
  const privateReason = "private report details must never leak";

  const agent = moderation.artifactUnavailableResponse(
    new Request("https://artifacts.example.com/go/demo-abc123/", {
      headers: { Accept: "application/json" },
    }),
  );
  assert.equal(agent.status, 410);
  assert.match(agent.headers.get("Content-Type") || "", /application\/json/);
  const agentText = await agent.text();
  assert.equal(JSON.parse(agentText).error.code, "artifact_unavailable");
  assert.doesNotMatch(agentText, /private/i);

  const browser = moderation.artifactUnavailableResponse(
    new Request("https://artifacts.example.com/go/demo-abc123/", {
      headers: { Accept: "text/html" },
    }),
  );
  assert.equal(browser.status, 410);
  assert.match(browser.headers.get("Content-Type") || "", /text\/html/);
  const html = await browser.text();
  assert.match(html, /unavailable/i);
  assert.doesNotMatch(html, new RegExp(privateReason, "i"));
});

test("artifact suspension short-circuits every public surface", async () => {
  const state = fakeEnv({ artifactStatus: "suspended" });
  const cases: Array<[string, Promise<Response>]> = [
    [
      "artifact HTML",
      servePublic(
        new Request("https://artifacts.example.com/go/demo-abc123/"),
        state.env,
        "/go/demo-abc123/",
      ),
    ],
    [
      "comments",
      handleComments(
        new Request(
          "https://artifacts.example.com/_au/comments?artifact_key=demo-abc123",
        ),
        state.env,
        "/_au/comments",
      ),
    ],
    [
      "viewer agent token",
      handleAgentToken(
        new Request("https://artifacts.example.com/_au/agent-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"artifact_key":"demo-abc123"}',
        }),
        state.env,
      ),
    ],
    [
      "plain email gate",
      handleGateRoute(
        new Request("https://artifacts.example.com/_au/gate/email", {
          method: "POST",
          body: new URLSearchParams({
            artifact_key: "demo-abc123",
            email: "viewer@example.com",
          }),
        }),
        state.env,
        "/_au/gate/email",
      ),
    ],
  ];

  for (const [label, pending] of cases) {
    const response = await pending;
    assert.equal(response.status, 410, label);
    assert.equal((await response.json()).error.code, "artifact_unavailable");
  }
  assert.equal(state.bucketReads, 0);
  assert.equal(state.mutations, 0);
});

test("organization suspension rejects new publish creation", async () => {
  const state = fakeEnv({ orgSuspended: true });
  const response = await handlePublish(
    new Request("https://artifacts.example.com/api/v1/publish/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer local-publisher-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ artifact: "new-demo", gate_level: "public" }),
    }),
    state.env,
    "/api/v1/publish/start",
  );

  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.code, "organization_suspended");
  assert.equal(state.mutations, 0);
});

test("artifact and organization actions each append one audit event", async () => {
  const moderation = await import("../src/moderation.ts");
  assert.equal(typeof moderation.moderateArtifact, "function");
  assert.equal(typeof moderation.moderateOrganization, "function");

  const events: Array<{ sql: string; values: unknown[] }> = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          return sql.includes("FROM artifacts")
            ? { id: artifact.id, org_id: artifact.org_id }
            : null;
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(batch: Array<{ sql: string; values: unknown[] }>) {
      for (const statement of batch) {
        if (statement.sql.includes("INSERT INTO moderation_events"))
          events.push(statement);
      }
      return batch.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const testEnv = { DB: db } as unknown as Env;

  assert.equal(
    await moderation.moderateArtifact(testEnv, {
      actorUserId: "user_operator",
      artifactId: artifact.id,
      action: "suspend",
      reason: "malware report",
    }),
    true,
  );
  assert.equal(
    await moderation.moderateArtifact(testEnv, {
      actorUserId: "user_operator",
      artifactId: artifact.id,
      action: "restore",
      reason: null,
    }),
    true,
  );
  await moderation.moderateOrganization(testEnv, {
    actorUserId: "user_operator",
    orgId: artifact.org_id,
    action: "suspend",
    reason: "repeat abuse",
  });
  await moderation.moderateOrganization(testEnv, {
    actorUserId: "user_operator",
    orgId: artifact.org_id,
    action: "restore",
    reason: null,
  });

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => [event.values[2], event.values[5]]),
    [
      ["artifact", "suspend"],
      ["artifact", "restore"],
      ["org", "suspend"],
      ["org", "restore"],
    ],
  );
  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("SET status = 'suspended'"),
    ),
  );
  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("SET status = 'active'"),
    ),
  );
  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("INSERT INTO org_suspensions"),
    ),
  );
  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("DELETE FROM org_suspensions"),
    ),
  );
});

test("super-admin moderation routes validate reasons and expose four actions", async () => {
  const state = operatorEnv();
  const blank = await adminPost(state.env, "/admin/super/artifact/suspend", {
    artifact_id: artifact.id,
    reason: "   ",
  });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).error.code, "moderation_reason_required");
  assert.equal(state.dbCalls, 0);

  const tooLong = await adminPost(state.env, "/admin/super/org/suspend", {
    org_id: artifact.org_id,
    reason: "x".repeat(501),
  });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, "moderation_reason_too_long");
  assert.equal(state.dbCalls, 0);

  for (const [path, form] of [
    [
      "/admin/super/artifact/suspend",
      { artifact_id: artifact.id, reason: "malware report" },
    ],
    ["/admin/super/artifact/restore", { artifact_id: artifact.id }],
    [
      "/admin/super/org/suspend",
      { org_id: artifact.org_id, reason: "repeat abuse" },
    ],
    ["/admin/super/org/restore", { org_id: artifact.org_id }],
  ] satisfies Array<[string, Record<string, string>]>) {
    const response = await adminPost(state.env, path, form);
    assert.equal(response.status, 302, path);
  }
  assert.equal(state.events, 4);
});

async function adminPost(
  env: Env,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_operator",
    orgId: "org_operator",
    email: "operator@example.com",
    name: "Operator",
    exp: nowSec() + 600,
  };
  const rawSession = await signPayload(session, env);
  const csrf = await issueAdminCsrfToken(rawSession, session.exp, env);
  return handlePublisherAdmin(
    new Request(`https://artifacts.example.com${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `au_pub=${encodeURIComponent(rawSession)}; au_admin_csrf=${encodeURIComponent(csrf.token)}`,
        "X-CSRF-Token": csrf.token,
      },
      body: new URLSearchParams(fields),
    }),
    env,
    path,
  );
}

function operatorEnv(): { env: Env; dbCalls: number; events: number } {
  const counters = { dbCalls: 0, events: 0 };
  const db = {
    prepare(sql: string) {
      counters.dbCalls += 1;
      const statement = {
        sql,
        bind(..._values: unknown[]) {
          return statement;
        },
        async first() {
          return sql.includes("FROM artifacts")
            ? { id: artifact.id, org_id: artifact.org_id }
            : null;
        },
      };
      return statement;
    },
    async batch(batch: Array<{ sql: string }>) {
      counters.events += batch.filter((statement) =>
        statement.sql.includes("INSERT INTO moderation_events"),
      ).length;
      return batch.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return {
    env: {
      DB: db,
      SESSION_SECRET: "operator-test-secret",
      SITE_BASE_URL: "https://artifacts.example.com",
      ARTIFACT_USE_SUPER_ADMIN_USER_IDS: "user_operator",
    } as unknown as Env,
    get dbCalls() {
      return counters.dbCalls;
    },
    get events() {
      return counters.events;
    },
  };
}

function fakeEnv(options: {
  artifactStatus?: Artifact["status"];
  orgSuspended?: boolean;
}): { env: Env; bucketReads: number; mutations: number } {
  const suspendedArtifact: Artifact = {
    ...artifact,
    status: options.artifactStatus || "active",
  };
  const version: ArtifactVersion = {
    id: "ver_test",
    artifact_id: suspendedArtifact.id,
    org_id: suspendedArtifact.org_id,
    status: "complete",
    entrypoint: "index.html",
    manifest_json: JSON.stringify({ entrypoint: "index.html", files: [] }),
    total_size: 13,
    file_count: 1,
    created_by: "user_test",
    created_at: 1,
    completed_at: 1,
  };
  const file: ArtifactFile = {
    version_id: version.id,
    path: "index.html",
    storage_key: "test/index.html",
    content_type: "text/html; charset=utf-8",
    size: 13,
    sha256: null,
    uploaded_at: 1,
  };
  const counters = { bucketReads: 0, mutations: 0 };
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(..._values: unknown[]) {
          return statement;
        },
        async first() {
          if (sql.includes("SELECT org_id FROM org_suspensions"))
            return options.orgSuspended
              ? {
                  org_id: suspendedArtifact.org_id,
                  reason: "private reason",
                  actor_user_id: "user_operator",
                  created_at: 1,
                }
              : null;
          if (sql.includes("artifact_versions")) return version;
          if (sql.includes("artifact_files")) return file;
          if (sql.includes("share_links")) return null;
          if (sql.includes("WHERE org_id = ? AND slug = ?")) return null;
          if (sql.includes("artifacts")) return suspendedArtifact;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          counters.mutations += 1;
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      counters.mutations += statements.length;
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const bucket = {
    async get() {
      counters.bucketReads += 1;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<h1>demo</h1>"));
            controller.close();
          },
        }),
        size: 13,
        uploaded: new Date(0),
        httpEtag: '"test"',
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        writeHttpMetadata(headers: Headers) {
          headers.set("Content-Type", "text/html; charset=utf-8");
        },
        async text() {
          return "<h1>demo</h1>";
        },
      };
    },
    async put() {
      counters.mutations += 1;
      return { size: 13 };
    },
    async delete() {},
  };
  const env = {
    DB: db,
    BUCKET: bucket,
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "moderation-test-secret",
    DEV_AUTH_TOKEN: "local-publisher-token",
    DEV_AUTH_USER_ID: "user_test",
    DEV_AUTH_ORG_ID: suspendedArtifact.org_id,
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  return {
    env,
    get bucketReads() {
      return counters.bucketReads;
    },
    get mutations() {
      return counters.mutations;
    },
  };
}
