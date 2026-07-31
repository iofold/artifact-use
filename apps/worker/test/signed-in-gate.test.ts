import assert from "node:assert/strict";
import test from "node:test";
import { signPayload, verifyPayload } from "../src/auth.ts";
import { handleGateRoute, renderGate } from "../src/gate.ts";
import { handleComments, servePublic } from "../src/serve.ts";
import type {
  Artifact,
  Env,
  PublisherSession,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const ORIGIN = "https://artifacts.example.com";
const ARTIFACT_PATH = "/go/gate-demo-abc123/";

function gateArtifact(
  gateLevel: Artifact["gate_level"],
  allowlistJson: string | null = null,
): Artifact {
  return {
    id: "art_gate",
    org_id: "org_gate",
    slug: "gate-demo",
    url_key: "gate-demo-abc123",
    title: "Gate demo",
    description: null,
    gate_level: gateLevel,
    allowlist_json: allowlistJson,
    current_version_id: "ver_gate",
    created_by: "user_gate",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
}

function gateState(
  artifact: Artifact,
  options: {
    rateCount?: (bucket: string) => number;
    memberships?: Array<{ org_id: string }>;
  } = {},
) {
  const state = {
    viewWrites: [] as unknown[][],
    commentWrites: [] as unknown[][],
    rateBuckets: [] as string[],
  };
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
            return { count: options.rateCount?.(bucket) || 1 };
          }
          if (sql.includes("FROM artifacts")) return artifact;
          if (sql.includes("workspace_membership_sync"))
            return { refreshed_at: nowSec() };
          return null;
        },
        async all() {
          if (sql.includes("FROM workspace_memberships"))
            return {
              results: (options.memberships || []).map((row) => ({
                org_name: "Other Org",
                org_slug: "other-org",
                role: "member",
                ...row,
              })),
            };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO views"))
            state.viewWrites.push(statement.values);
          if (sql.includes("INSERT INTO comments"))
            state.commentWrites.push(statement.values);
          return { meta: { changes: 1, last_row_id: 7 } };
        },
      };
      return statement;
    },
  };
  const env = {
    DB: db,
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "signed-in-gate-secret",
  } as unknown as Env;
  return { env, state };
}

async function publisherCookie(
  env: Env,
  overrides: Partial<PublisherSession> = {},
): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_member",
    orgId: "org_gate",
    email: "Member@Example.com",
    name: "Member",
    exp: nowSec() + 600,
    ...overrides,
  };
  return `au_pub=${encodeURIComponent(await signPayload(session, env))}`;
}

function browserGet(url: string, cookie?: string): Request {
  const headers = new Headers({
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
  if (cookie) headers.set("Cookie", cookie);
  return new Request(url, { headers });
}

function consentPost(
  cookie: string | null,
  options: {
    accept?: string;
    referer?: string | null;
    mode?: string;
    dest?: string;
    artifactKey?: string;
  } = {},
): Request {
  const headers = new Headers({
    Accept: options.accept || "application/json",
    "CF-Connecting-IP": "203.0.113.9",
    "Sec-Fetch-Mode": options.mode || "navigate",
    "Sec-Fetch-Dest": options.dest || "document",
  });
  if (options.referer !== null)
    headers.set("Referer", options.referer || `${ORIGIN}${ARTIFACT_PATH}`);
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`${ORIGIN}/_au/gate/session`, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      artifact_key: options.artifactKey || "gate-demo-abc123",
      redirect_to: ARTIFACT_PATH,
    }),
  });
}

async function viewerFromCookie(
  env: Env,
  response: Response,
): Promise<ViewerSession | null> {
  const setCookie = response.headers.get("Set-Cookie") || "";
  const match = /au_art_gate=([^;]+)/.exec(setCookie);
  if (!match) return null;
  return verifyPayload<ViewerSession>(decodeURIComponent(match[1]), env);
}

test("a signed-in member auto-passes a verified gate with a bounce redirect", async () => {
  const { env, state } = gateState(gateArtifact("verified_email"));
  const response = await servePublic(
    browserGet(`${ORIGIN}${ARTIFACT_PATH}`, await publisherCookie(env)),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), `${ARTIFACT_PATH}?au_sso=1`);
  const session = await viewerFromCookie(env, response);
  assert.ok(session);
  assert.equal(session.verified, true);
  assert.equal(session.email, "member@example.com");
  assert.equal(session.artifact_id, "art_gate");
  assert.equal(state.viewWrites.length, 1);
});

test("membership via the multi-workspace snapshot also auto-passes", async () => {
  const { env } = gateState(gateArtifact("verified_email"), {
    memberships: [{ org_id: "org_gate" }],
  });
  const cookie = await publisherCookie(env, { orgId: "org_other" });
  const response = await servePublic(
    browserGet(`${ORIGIN}${ARTIFACT_PATH}`, cookie),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 302);
  assert.ok((await viewerFromCookie(env, response))?.verified);
});

test("the au_sso bounce marker renders the manual gate instead of looping", async () => {
  const { env, state } = gateState(gateArtifact("verified_email"));
  const response = await servePublic(
    browserGet(
      `${ORIGIN}${ARTIFACT_PATH}?au_sso=1`,
      await publisherCookie(env),
    ),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Continue as member@example\.com/);
  assert.equal(state.viewWrites.length, 0);
});

test("a signed-in non-member sees one-click consent, not a silent pass", async () => {
  const { env, state } = gateState(gateArtifact("verified_email"));
  const cookie = await publisherCookie(env, {
    orgId: "org_other",
    email: "visitor@example.com",
    sub: "user_visitor",
  });
  const response = await servePublic(
    browserGet(`${ORIGIN}${ARTIFACT_PATH}`, cookie),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Continue as visitor@example\.com/);
  assert.match(body, /value="visitor@example\.com"/);
  assert.equal(state.viewWrites.length, 0);
});

test("anonymous viewers get the unchanged email gate", async () => {
  const { env } = gateState(gateArtifact("verified_email"));
  const response = await servePublic(
    browserGet(`${ORIGIN}${ARTIFACT_PATH}`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /Continue as/);
  assert.match(body, /Enter your email to continue/);
});

test("gate/session mints a verified session for a member", async () => {
  const { env, state } = gateState(gateArtifact("verified_email"));
  const response = await handleGateRoute(
    consentPost(await publisherCookie(env)),
    env,
    "/_au/gate/session",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token: string };
  const session = await verifyPayload<ViewerSession>(body.token, env);
  assert.equal(session?.verified, true);
  assert.equal(session?.email, "member@example.com");
  assert.equal(state.viewWrites.length, 1);
});

test("gate/session redirects browser form submits back to the artifact", async () => {
  const { env } = gateState(gateArtifact("email"));
  const response = await handleGateRoute(
    consentPost(await publisherCookie(env), { accept: "text/html" }),
    env,
    "/_au/gate/session",
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), ARTIFACT_PATH);
  assert.ok((await viewerFromCookie(env, response))?.verified);
});

test("gate/session enforces the allowlist for non-members but not members", async () => {
  const allowlist = JSON.stringify({ emails: ["visitor@example.com"] });
  for (const [email, member, expected] of [
    ["visitor@example.com", false, 200],
    ["stranger@example.com", false, 403],
    ["member@example.com", true, 200],
  ] as const) {
    const { env } = gateState(gateArtifact("allowlist", allowlist));
    const cookie = await publisherCookie(env, {
      email,
      orgId: member ? "org_gate" : "org_other",
      sub: member ? "user_member" : "user_visitor",
    });
    const response = await handleGateRoute(
      consentPost(cookie),
      env,
      "/_au/gate/session",
    );
    assert.equal(response.status, expected, email);
    if (expected === 403)
      assert.equal((await response.json()).error.code, "email_not_allowed");
  }
});

test("gate/session rejects requests that are not a consent click", async () => {
  const cases: Array<Parameters<typeof consentPost>[1]> = [
    { referer: null },
    { referer: "https://evil.example.net" + ARTIFACT_PATH },
    { referer: `${ORIGIN}/go/other-artifact/` },
    { mode: "cors" },
    { dest: "iframe" },
  ];
  for (const [index, options] of cases.entries()) {
    const { env, state } = gateState(gateArtifact("verified_email"));
    const response = await handleGateRoute(
      consentPost(await publisherCookie(env), options),
      env,
      "/_au/gate/session",
    );
    assert.equal(response.status, 403, `case ${index}`);
    assert.equal((await response.json()).error.code, "consent_required");
    assert.equal(state.viewWrites.length, 0);
  }
});

test("gate/session without a signed-in session is a 401", async () => {
  const { env } = gateState(gateArtifact("verified_email"));
  const response = await handleGateRoute(
    consentPost(null),
    env,
    "/_au/gate/session",
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "sign_in_required");
});

test("gate/session rejects public artifacts and honors the IP session cap", async () => {
  const publicState = gateState(gateArtifact("public"));
  const publicResponse = await handleGateRoute(
    consentPost(await publisherCookie(publicState.env)),
    publicState.env,
    "/_au/gate/session",
  );
  assert.equal(publicResponse.status, 400);
  assert.equal((await publicResponse.json()).error.code, "gate_not_required");

  const limited = gateState(gateArtifact("verified_email"), {
    rateCount: (bucket) => (bucket.startsWith("gate:email:ip:hour:") ? 61 : 1),
  });
  const limitedResponse = await handleGateRoute(
    consentPost(await publisherCookie(limited.env)),
    limited.env,
    "/_au/gate/session",
  );
  assert.equal(limitedResponse.status, 429);
  assert.equal(limited.state.viewWrites.length, 0);
});

test("renderGate hides one-click when the allowlist would reject the email", async () => {
  const allowlist = JSON.stringify({ emails: ["allowed@example.com"] });
  const blocked = await renderGate(
    gateArtifact("allowlist", allowlist),
    ARTIFACT_PATH,
    "",
    "",
    "stranger@example.com",
  ).text();
  assert.doesNotMatch(blocked, /Continue as/);
  assert.doesNotMatch(blocked, /value="stranger@example\.com"/);
  const allowed = await renderGate(
    gateArtifact("allowlist", allowlist),
    ARTIFACT_PATH,
    "",
    "",
    "allowed@example.com",
  ).text();
  assert.match(allowed, /Continue as allowed@example\.com/);
});

test("members read gated comments with only their admin session", async () => {
  const { env } = gateState(gateArtifact("verified_email"));
  const headers = new Headers({
    Accept: "application/json",
    Cookie: await publisherCookie(env),
    Referer: `${ORIGIN}${ARTIFACT_PATH}`,
  });
  const response = await handleComments(
    new Request(`${ORIGIN}/_au/comments?artifact_key=gate-demo-abc123`, {
      headers,
    }),
    env,
    "/_au/comments",
  );
  assert.equal(response.status, 200);
});

test("non-members still need a viewer session for gated comments", async () => {
  const { env } = gateState(gateArtifact("verified_email"));
  const headers = new Headers({
    Accept: "application/json",
    Cookie: await publisherCookie(env, {
      orgId: "org_other",
      sub: "user_visitor",
    }),
  });
  const response = await handleComments(
    new Request(`${ORIGIN}/_au/comments?artifact_key=gate-demo-abc123`, {
      headers,
    }),
    env,
    "/_au/comments",
  );
  assert.equal(response.status, 401);
});

test("members post public-artifact comments without the email step", async () => {
  const { env, state } = gateState(gateArtifact("public"));
  const response = await handleComments(
    new Request(`${ORIGIN}/_au/comments`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
        Cookie: await publisherCookie(env),
        Referer: `${ORIGIN}${ARTIFACT_PATH}`,
      },
      body: JSON.stringify({
        artifact_key: "gate-demo-abc123",
        body: "Ship it",
      }),
    }),
    env,
    "/_au/comments",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { comment?: { email?: string } };
  assert.equal(body.comment?.email, "member@example.com");
  assert.equal(state.commentWrites.length, 1);
});

test("a referer outside the artifact blocks the cookie comment identity", async () => {
  const { env, state } = gateState(gateArtifact("public"));
  const response = await handleComments(
    new Request(`${ORIGIN}/_au/comments`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
        Cookie: await publisherCookie(env),
        Referer: `${ORIGIN}/go/other-artifact/`,
      },
      body: JSON.stringify({
        artifact_key: "gate-demo-abc123",
        body: "Ship it",
      }),
    }),
    env,
    "/_au/comments",
  );
  assert.equal(response.status, 401);
  assert.equal(state.commentWrites.length, 0);
});
