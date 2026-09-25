import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { mintCreatorToken, signPayload, verifyPayload } from "../src/auth.ts";
import {
  emailDomainAcceptsMail,
  handleGateRoute,
  resetEmailDomainCache,
  validEmail,
} from "../src/gate.ts";
import { hashPasscode, randomSalt, type ShareLink } from "../src/links.ts";
import { handleMcp } from "../src/mcp.ts";
import { servePublic } from "../src/serve.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const ORIGIN = "https://artifacts.example.com";
const ARTIFACT_PATH = "/go/gate-demo-abc123/";
const HTML =
  "<!doctype html><html><head></head><body>secret body</body></html>";

function gateArtifact(gateLevel: Artifact["gate_level"] = "email"): Artifact {
  return {
    id: "art_gate",
    org_id: "org_gate",
    slug: "gate-demo",
    url_key: "gate-demo-abc123",
    title: "Gate demo",
    description: null,
    gate_level: gateLevel,
    allowlist_json: null,
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

const version: ArtifactVersion = {
  id: "ver_gate",
  artifact_id: "art_gate",
  org_id: "org_gate",
  status: "complete",
  entrypoint: "index.html",
  manifest_json: null,
  total_size: HTML.length,
  file_count: 1,
  created_by: "user_gate",
  created_at: 1,
  completed_at: 1,
};

const htmlFile: ArtifactFile = {
  version_id: "ver_gate",
  path: "index.html",
  storage_key: "orgs/org_gate/artifacts/art_gate/versions/ver_gate/index.html",
  content_type: "text/html; charset=utf-8",
  size: HTML.length,
  sha256: null,
  uploaded_at: 1,
};

function link(overrides: Partial<ShareLink> & { id: string }): ShareLink {
  return {
    artifact_id: "art_gate",
    kind: "recipient",
    label: null,
    recipient_email: null,
    recipient_label: null,
    password_hash: null,
    password_salt: null,
    max_opens: null,
    open_count: 0,
    last_opened_at: null,
    expires_at: null,
    revoked_at: null,
    created_by: "user_gate",
    created_at: 1,
    ...overrides,
  };
}

async function passwordLink(
  id: string,
  passcode: string,
  overrides: Partial<ShareLink> = {},
): Promise<ShareLink> {
  const salt = randomSalt();
  return link({
    id,
    kind: "password",
    password_salt: salt,
    password_hash: await hashPasscode(passcode, salt),
    ...overrides,
  });
}

// A fake D1/R2 pair that keeps share links in a map so opens, revocations
// and inserts round-trip the way the real tables would.
function linkState(
  artifact: Artifact,
  links: ShareLink[] = [],
  options: { rateCount?: (bucket: string) => number } = {},
) {
  const store = new Map(links.map((row) => [row.id, { ...row }]));
  const state = {
    viewWrites: [] as unknown[][],
    opens: [] as string[],
    rateBuckets: [] as string[],
    rateDeletes: [] as string[],
    bucketReads: 0,
    inserts: [] as unknown[][],
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
          if (
            sql.includes("FROM share_links WHERE id = ? AND artifact_id = ?")
          ) {
            const row = store.get(String(statement.values[0]));
            return row && row.artifact_id === statement.values[1] ? row : null;
          }
          if (sql.includes("FROM creator_tokens"))
            return { revoked_at: null, last_used_at: null };
          if (sql.includes("FROM artifact_versions")) return version;
          if (sql.includes("FROM artifact_files")) return htmlFile;
          if (sql.includes("FROM artifacts")) return artifact;
          return null;
        },
        async all() {
          if (sql.includes("FROM share_links sl"))
            return {
              results: [...store.values()].map((row) => ({
                ...row,
                password_hash: undefined,
                password_salt: undefined,
                view_count: state.viewWrites.filter(
                  (values) => values[2] === row.id,
                ).length,
              })),
            };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO views")) {
            state.viewWrites.push(statement.values);
            return {
              meta: { changes: 1, last_row_id: state.viewWrites.length },
            };
          }
          if (sql.includes("UPDATE share_links SET open_count")) {
            const row = store.get(String(statement.values[1]));
            if (row) {
              row.open_count = Number(row.open_count || 0) + 1;
              row.last_opened_at = Number(statement.values[0]);
              state.opens.push(row.id);
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes("UPDATE share_links SET revoked_at")) {
            const row = store.get(String(statement.values[1]));
            if (!row || row.revoked_at) return { meta: { changes: 0 } };
            row.revoked_at = Number(statement.values[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO share_links")) {
            const v = statement.values;
            state.inserts.push(v);
            store.set(String(v[0]), {
              id: String(v[0]),
              artifact_id: String(v[1]),
              kind: String(v[2]),
              label: (v[3] as string) || null,
              recipient_email: (v[4] as string) || null,
              recipient_label: (v[5] as string) || null,
              password_hash: (v[6] as string) || null,
              password_salt: (v[7] as string) || null,
              max_opens: (v[8] as number) || null,
              open_count: 0,
              last_opened_at: null,
              expires_at: (v[9] as number) || null,
              revoked_at: null,
              created_by: String(v[10]),
              created_at: Number(v[11]),
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM rate_counters WHERE bucket = ?"))
            state.rateDeletes.push(String(statement.values[0] || ""));
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
  };
  const env = {
    DB: db,
    BUCKET: {
      async get() {
        state.bucketReads += 1;
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(HTML));
              controller.close();
            },
          }),
          size: HTML.length,
          uploaded: new Date(0),
          httpEtag: '"links-test"',
          httpMetadata: { contentType: htmlFile.content_type },
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", htmlFile.content_type);
          },
          async text() {
            return HTML;
          },
        };
      },
      async head() {
        return null;
      },
    },
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "links-and-gates-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_gate",
    DEV_AUTH_ORG_ID: artifact.org_id,
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  return { env, state, store };
}

function browser(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/html,application/xhtml+xml");
  headers.set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  headers.set("CF-Connecting-IP", "203.0.113.9");
  return new Request(url, { ...init, headers });
}

function agent(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("CF-Connecting-IP", "203.0.113.9");
  return new Request(url, { ...init, headers });
}

function gateLink(
  env: Env,
  fields: Record<string, string>,
  accept = "application/json",
): Promise<Response> {
  return handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/link`, {
      method: "POST",
      headers: { Accept: accept, "CF-Connecting-IP": "203.0.113.9" },
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        ...fields,
      }),
    }),
    env,
    "/_au/gate/link",
  );
}

async function sessionFromSetCookie(
  env: Env,
  response: Response,
): Promise<ViewerSession | null> {
  const match = /au_art_gate=([^;]+)/.exec(
    response.headers.get("Set-Cookie") || "",
  );
  if (!match) return null;
  return verifyPayload<ViewerSession>(decodeURIComponent(match[1]), env);
}

type Captured = { url: string; init: RequestInit & { headers: Headers } };

function stubFetch(
  respond: (captured: Captured) => Response | Promise<Response>,
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const captured = {
      url: String(input),
      init: { ...(init || {}), headers: new Headers(init?.headers) },
    };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function dnsAnswer(status: number, types: number[] = []): Response {
  return new Response(
    JSON.stringify({ Status: status, Answer: types.map((type) => ({ type })) }),
    { headers: { "Content-Type": "application/dns-json" } },
  );
}

// ---- password links -------------------------------------------------------

test("a password link shows a passcode form to browsers and a 401 with link_kind to agents", async () => {
  const { env, state } = linkState(gateArtifact(), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const page = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}?v=pwlink0000000001&tab=2`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="passcode" type="password"/);
  assert.match(html, /action="\/_au\/gate\/link"/);
  assert.match(html, /name="link" value="pwlink0000000001"/);
  assert.match(
    html,
    /name="redirect_to" value="\/go\/gate-demo-abc123\/\?tab=2"/,
  );
  assert.doesNotMatch(html, /name="email"/);
  assert.doesNotMatch(html, /secret body/);

  const machine = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}?v=pwlink0000000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(machine.status, 401);
  const body = (await machine.json()) as {
    error: { code: string };
    link_kind: string;
    link_id: string;
    access: { passcode_self_serve: string; basic: string };
  };
  assert.equal(body.error.code, "gate_required");
  assert.equal(body.link_kind, "password");
  assert.equal(body.link_id, "pwlink0000000001");
  assert.match(body.access.passcode_self_serve, /_au\/gate\/link/);
  assert.match(body.access.basic, /Basic/);
  assert.equal(state.viewWrites.length, 0);
  assert.equal(state.opens.length, 0);
});

test("the right passcode mints a link session: one view, one open, then free reads", async () => {
  const { env, state } = linkState(gateArtifact("verified_email"), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const response = await gateLink(env, {
    link: "pwlink0000000001",
    passcode: " open-sesame ",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token: string };
  const session = await verifyPayload<ViewerSession>(body.token, env);
  assert.equal(session?.email, "link:pwlink0000000001");
  assert.equal(session?.verified, false);
  assert.equal(session?.link_id, "pwlink0000000001");
  assert.equal(state.viewWrites.length, 1);
  assert.equal(state.viewWrites[0]?.[2], "pwlink0000000001");
  assert.equal(state.viewWrites[0]?.[3], "link:pwlink0000000001");
  assert.equal(state.viewWrites[0]?.[4], 0);
  assert.deepEqual(state.opens, ["pwlink0000000001"]);
  // The window of failed guesses is cleared on success.
  assert.ok(
    state.rateDeletes.some((bucket) => bucket.startsWith("gate:link:15m:")),
  );

  // The bearer reads a verified_email artifact: the link outranks the OTP.
  const read = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}`, {
      headers: { Authorization: `Bearer ${body.token}` },
    }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(read.status, 200);
  assert.match(await read.text(), /secret body/);
  assert.equal(state.viewWrites.length, 1);
  assert.deepEqual(state.opens, ["pwlink0000000001"]);
});

test("a browser's passcode submit redirects back with the cookie set", async () => {
  const { env } = linkState(gateArtifact(), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const response = await gateLink(
    env,
    {
      link: "pwlink0000000001",
      passcode: "open-sesame",
      redirect_to: `${ARTIFACT_PATH}?tab=2`,
    },
    "text/html",
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), `${ARTIFACT_PATH}?tab=2`);
  const session = await sessionFromSetCookie(env, response);
  assert.equal(session?.link_id, "pwlink0000000001");
});

test("a wrong passcode is a 401 and guesses are rate-limited per link and IP", async () => {
  const wrong = linkState(gateArtifact(), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const denied = await gateLink(wrong.env, {
    link: "pwlink0000000001",
    passcode: "guess",
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "invalid_passcode");
  assert.equal(wrong.state.viewWrites.length, 0);
  assert.equal(wrong.state.opens.length, 0);
  assert.ok(
    wrong.state.rateBuckets.some((bucket) =>
      bucket.startsWith("gate:link:15m:pwlink0000000001:"),
    ),
  );
  assert.ok(wrong.state.rateBuckets.every((b) => !b.includes("203.0.113.9")));

  const page = await gateLink(
    wrong.env,
    { link: "pwlink0000000001", passcode: "guess" },
    "text/html",
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), /passcode is not right/);

  const limited = linkState(
    gateArtifact(),
    [await passwordLink("pwlink0000000001", "open-sesame")],
    { rateCount: (bucket) => (bucket.startsWith("gate:link:15m:") ? 11 : 1) },
  );
  const blocked = await gateLink(limited.env, {
    link: "pwlink0000000001",
    passcode: "open-sesame",
  });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "rate_limited");
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.equal(limited.state.viewWrites.length, 0);
});

test("HTTP Basic with the link id and passcode reads the artifact inline", async () => {
  const { env, state } = linkState(gateArtifact(), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const basic = `Basic ${btoa("pwlink0000000001:open-sesame")}`;
  const response = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}`, { headers: { Authorization: basic } }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /secret body/);
  assert.match(response.headers.get("Set-Cookie") || "", /^au_art_gate=/);
  assert.equal(state.viewWrites.length, 1);
  assert.deepEqual(state.opens, ["pwlink0000000001"]);

  const wrong = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}?v=pwlink0000000001`, {
      headers: { Authorization: `Basic ${btoa(":nope")}` },
    }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).link_kind, "password");
  assert.equal(state.viewWrites.length, 1);
});

// ---- dead links -----------------------------------------------------------

test("expired, revoked and exhausted links answer 410 in both shapes", async () => {
  const cases: Array<[string, Partial<ShareLink>, string]> = [
    ["expired", { expires_at: nowSec() - 60 }, "link_expired"],
    ["revoked", { revoked_at: nowSec() - 60 }, "link_revoked"],
    ["exhausted", { max_opens: 2, open_count: 2 }, "link_exhausted"],
  ];
  for (const [label, overrides, code] of cases) {
    const { env, state } = linkState(gateArtifact(), [
      link({ id: "deadlink00000001", kind: "open", ...overrides }),
    ]);
    const page = await servePublic(
      browser(`${ORIGIN}${ARTIFACT_PATH}?v=deadlink00000001`),
      env,
      ARTIFACT_PATH,
    );
    assert.equal(page.status, 410, label);
    assert.match(page.headers.get("Content-Type") || "", /text\/html/);
    assert.match(await page.text(), /no longer works/);

    const machine = await servePublic(
      agent(`${ORIGIN}${ARTIFACT_PATH}?v=deadlink00000001`),
      env,
      ARTIFACT_PATH,
    );
    assert.equal(machine.status, 410, label);
    const body = (await machine.json()) as {
      error: { code: string };
      link_state: string;
    };
    assert.equal(body.error.code, code);
    assert.equal(body.link_state, label);

    const form = await gateLink(env, { link: "deadlink00000001" });
    assert.equal(form.status, 410, label);
    assert.equal(state.viewWrites.length, 0);
    assert.equal(state.opens.length, 0);
  }
});

test("the last permitted open still works; the next one is exhausted", async () => {
  const { env, state, store } = linkState(gateArtifact(), [
    link({ id: "openlink00000001", kind: "open", max_opens: 1 }),
  ]);
  const first = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}?v=openlink00000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(first.status, 200);
  assert.equal(store.get("openlink00000001")?.open_count, 1);
  const session = await sessionFromSetCookie(env, first);
  assert.ok(session);
  // The session minted by the last allowed open keeps reading.
  const again = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}index.html`, {
      headers: {
        Cookie: `au_art_gate=${encodeURIComponent(await signPayload(session, env))}`,
      },
    }),
    env,
    `${ARTIFACT_PATH}index.html`,
  );
  assert.equal(again.status, 200);
  const next = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}?v=openlink00000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(next.status, 410);
  assert.equal(state.viewWrites.length, 1);
});

test("a link session stops working once the link is revoked", async () => {
  const { env, store } = linkState(gateArtifact("verified_email"), [
    link({ id: "openlink00000001", kind: "open" }),
  ]);
  const session: ViewerSession = {
    artifact_id: "art_gate",
    version_id: "ver_gate",
    email: "link:openlink00000001",
    verified: false,
    view_id: 1,
    exp: nowSec() + 600,
    link_id: "openlink00000001",
  };
  const cookie = `au_art_gate=${encodeURIComponent(await signPayload(session, env))}`;
  const before = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}`, { headers: { Cookie: cookie } }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(before.status, 200);
  store.get("openlink00000001")!.revoked_at = nowSec();
  const after = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}`, { headers: { Cookie: cookie } }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(after.status, 401);
});

// ---- recipient and open links ---------------------------------------------

test("a recipient link passes the gate and attributes the view to the recipient", async () => {
  const { env, state } = linkState(gateArtifact(), [
    link({
      id: "reciplink0000001",
      recipient_email: "client@example.com",
      recipient_label: "Client",
    }),
  ]);
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}?v=reciplink0000001&tab=2`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), `${ARTIFACT_PATH}?tab=2`);
  const session = await sessionFromSetCookie(env, response);
  assert.equal(session?.email, "client@example.com");
  assert.equal(session?.verified, false);
  assert.equal(session?.link_id, "reciplink0000001");
  assert.equal(state.viewWrites.length, 1);
  assert.equal(state.viewWrites[0]?.[2], "reciplink0000001");
  assert.equal(state.viewWrites[0]?.[3], "client@example.com");
  assert.equal(state.viewWrites[0]?.[4], 0);
  assert.deepEqual(state.opens, ["reciplink0000001"]);
});

test("an open link passes for anyone under the link identity", async () => {
  const { env, state } = linkState(gateArtifact("allowlist"), [
    link({ id: "openlink00000001", kind: "open", label: "Launch review" }),
  ]);
  const response = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}?v=openlink00000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /secret body/);
  assert.equal(state.viewWrites[0]?.[3], "link:openlink00000001");
  const session = await sessionFromSetCookie(env, response);
  assert.equal(session?.link_id, "openlink00000001");
});

test("share-link rows from before migration 0014 still pass as recipient links", async () => {
  const legacy = {
    id: "legacylink000001",
    artifact_id: "art_gate",
    recipient_email: "old@example.com",
    recipient_label: null,
    expires_at: null,
    revoked_at: null,
    created_by: "user_gate",
    created_at: 1,
  } as ShareLink;
  const { env, state } = linkState(gateArtifact(), [legacy]);
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}?v=legacylink000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 302);
  assert.equal(
    (await sessionFromSetCookie(env, response))?.email,
    "old@example.com",
  );
  assert.equal(state.viewWrites.length, 1);
});

test("an unknown link id falls back to the ordinary gate", async () => {
  const { env, state } = linkState(gateArtifact(), []);
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}?v=nosuchlink000001`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Enter your email to continue/);
  assert.match(html, /name="redirect_to" value="\/go\/gate-demo-abc123\/"/);
  assert.equal(state.viewWrites.length, 0);
});

// ---- creator tokens -------------------------------------------------------

test("a creator token of the owning workspace reads without a session or a view row", async () => {
  const { env, state } = linkState(gateArtifact("verified_email"));
  const minted = await mintCreatorToken(env, {
    sub: "user_gate",
    orgId: "org_gate",
    email: "publisher@example.com",
    label: "agent",
    source: "api",
    expiresDays: 30,
  });
  for (const method of ["GET", "HEAD"]) {
    const response = await servePublic(
      agent(`${ORIGIN}${ARTIFACT_PATH}`, {
        method,
        headers: { Authorization: `Bearer ${minted.token}` },
      }),
      env,
      ARTIFACT_PATH,
    );
    assert.equal(response.status, 200, method);
    if (method === "GET") assert.match(await response.text(), /secret body/);
  }
  const descriptor = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}_au/index.json`, {
      headers: { Authorization: `Bearer ${minted.token}` },
    }),
    env,
    `${ARTIFACT_PATH}_au/index.json`,
  );
  assert.equal(descriptor.status, 200);
  assert.equal(state.viewWrites.length, 0);
  assert.equal(state.opens.length, 0);

  const other = await mintCreatorToken(env, {
    sub: "user_other",
    orgId: "org_other",
    email: null,
    label: null,
    source: "api",
    expiresDays: 30,
  });
  const denied = await servePublic(
    agent(`${ORIGIN}${ARTIFACT_PATH}`, {
      headers: { Authorization: `Bearer ${other.token}` },
    }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "gate_required");
});

// ---- the plain email gate --------------------------------------------------

test("validEmail rejects the junk shapes the plain gate used to accept", () => {
  for (const bad of [
    "a@b",
    "x@localhost",
    "@@",
    "no-at-sign",
    "a@b.",
    "a@.com",
    "a b@example.com",
    "a@exa_mple.com",
    "a@example.c0m",
    `${"a".repeat(65)}@example.com`,
  ])
    assert.equal(validEmail(bad), false, bad);
  for (const good of [
    "viewer@example.com",
    "first.last+tag@sub.example.co.uk",
    "o'neil@example.org",
  ])
    assert.equal(validEmail(good), true, good);
});

test("the plain email gate asks DNS for MX/A and rejects domains with neither", async () => {
  resetEmailDomainCache();
  const stub = stubFetch(({ url }) => {
    const u = new URL(url);
    const name = u.searchParams.get("name");
    const type = u.searchParams.get("type");
    if (name === "example.com" && type === "MX") return dnsAnswer(0, [15]);
    if (name === "nomx.example")
      return type === "MX" ? dnsAnswer(0) : dnsAnswer(0, [1]);
    if (name === "nowhere.invalid") return dnsAnswer(3);
    return dnsAnswer(0);
  });
  try {
    const { env, state } = linkState(gateArtifact());
    const post = (email: string) =>
      handleGateRoute(
        agent(`${ORIGIN}/_au/gate/email`, {
          method: "POST",
          body: new URLSearchParams({
            artifact_key: "gate-demo-abc123",
            email,
          }),
        }),
        env,
        "/_au/gate/email",
      );
    const ok = await post("Viewer@Example.com");
    assert.equal(ok.status, 200);
    assert.equal(state.viewWrites.length, 1);
    assert.equal(stub.calls.length, 1);
    assert.equal(
      stub.calls[0]?.init.headers.get("Accept"),
      "application/dns-json",
    );
    assert.match(
      stub.calls[0]?.url || "",
      /^https:\/\/cloudflare-dns\.com\/dns-query\?name=example\.com&type=MX$/,
    );

    // Cached per isolate: the second viewer from the same domain costs nothing.
    await post("second@example.com");
    assert.equal(stub.calls.length, 1);

    // A records are enough when there is no MX.
    const aOnly = await post("someone@nomx.example");
    assert.equal(aOnly.status, 200);

    const bogus = await post("nobody@nowhere.invalid");
    assert.equal(bogus.status, 400);
    const body = (await bogus.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "invalid_email_domain");
    assert.match(body.error.message, /nowhere\.invalid/);
    assert.equal(state.viewWrites.length, 3);

    const page = await handleGateRoute(
      browser(`${ORIGIN}/_au/gate/email`, {
        method: "POST",
        body: new URLSearchParams({
          artifact_key: "gate-demo-abc123",
          email: "nobody@nowhere.invalid",
        }),
      }),
      env,
      "/_au/gate/email",
    );
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /no mail server/);
    assert.match(html, /value="nobody@nowhere\.invalid"/);
  } finally {
    stub.restore();
    resetEmailDomainCache();
  }
});

test("a DNS outage fails open", async () => {
  resetEmailDomainCache();
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    assert.equal(
      await emailDomainAcceptsMail("viewer@unreachable.example"),
      true,
    );
    const server = stubFetch(
      () => new Response("bad gateway", { status: 502 }),
    );
    try {
      assert.equal(await emailDomainAcceptsMail("viewer@flaky.example"), true);
    } finally {
      server.restore();
    }
  } finally {
    stub.restore();
    resetEmailDomainCache();
  }
});

test("the plain email route refuses public and verified artifacts", async () => {
  for (const [level, code] of [
    ["public", "gate_not_required"],
    ["verified_email", "otp_required"],
  ] as const) {
    const { env, state } = linkState(gateArtifact(level));
    const response = await handleGateRoute(
      agent(`${ORIGIN}/_au/gate/email`, {
        method: "POST",
        body: new URLSearchParams({
          artifact_key: "gate-demo-abc123",
          email: "viewer@example.com",
        }),
      }),
      env,
      "/_au/gate/email",
    );
    assert.equal(response.status, 400, level);
    assert.equal((await response.json()).error.code, code);
    assert.equal(state.viewWrites.length, 0);
  }
});

// ---- API and MCP ----------------------------------------------------------

function apiRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer dev-token");
  headers.set("Content-Type", "application/json");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

test("the share-links API creates, lists and revokes links; passcodes are shown once", async () => {
  const { env, state, store } = linkState(gateArtifact());
  const base = "/api/v1/artifacts/gate-demo-abc123/share-links";
  const created = await handleAdminApi(
    apiRequest(base, {
      method: "POST",
      body: JSON.stringify({
        kind: "password",
        label: "Board deck",
        expires_days: 7,
        max_opens: 3,
      }),
    }),
    env,
    base,
  );
  assert.equal(created.status, 200);
  const body = (await created.json()) as Record<string, unknown>;
  assert.equal(body.kind, "password");
  assert.equal(body.label, "Board deck");
  assert.equal(body.state, "active");
  assert.equal(body.max_opens, 3);
  assert.equal(body.open_count, 0);
  assert.match(String(body.passcode), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.match(
    String(body.url),
    /^https:\/\/artifacts\.example\.com\/go\/gate-demo-abc123\/\?v=[a-f0-9]{16}$/,
  );
  assert.match(String(body.note), /unlisted/);
  assert.ok(Number(body.expires_at) > nowSec() + 6 * 86400);
  const id = String(body.id);
  const stored = store.get(id);
  assert.ok(stored?.password_hash && stored.password_salt);
  assert.notEqual(stored.password_hash, body.passcode);

  // The stored hash verifies the passcode that was handed out.
  const pass = await gateLink(env, {
    link: id,
    passcode: String(body.passcode),
  });
  assert.equal(pass.status, 200);

  const custom = await handleAdminApi(
    apiRequest(base, {
      method: "POST",
      body: JSON.stringify({ kind: "password", passcode: "my-own-code" }),
    }),
    env,
    base,
  );
  assert.equal(custom.status, 200);
  assert.equal(
    ((await custom.json()) as { passcode: string }).passcode,
    "my-own-code",
  );

  const recipient = await handleAdminApi(
    apiRequest(base, {
      method: "POST",
      body: JSON.stringify({
        recipient_email: "Client@Example.com",
        recipient_label: "Client",
      }),
    }),
    env,
    base,
  );
  const recipientBody = (await recipient.json()) as Record<string, unknown>;
  assert.equal(recipientBody.kind, "recipient");
  assert.equal(recipientBody.recipient_email, "client@example.com");
  assert.equal(recipientBody.passcode, undefined);

  for (const [payload, code] of [
    [{ kind: "magic" }, "invalid_link_kind"],
    [{ kind: "open", passcode: "abc123" }, "invalid_passcode"],
    [{ kind: "password", passcode: "abc" }, "invalid_passcode"],
    [{ expires_days: 400 }, "invalid_expiry"],
    [{ max_opens: 0 }, "invalid_max_opens"],
    [{ recipient_email: "nope" }, "invalid_email"],
  ] as const) {
    const bad = await handleAdminApi(
      apiRequest(base, { method: "POST", body: JSON.stringify(payload) }),
      env,
      base,
    );
    assert.equal(bad.status, 400, JSON.stringify(payload));
    assert.equal((await bad.json()).error.code, code);
  }

  const listed = await handleAdminApi(apiRequest(base), env, base);
  assert.equal(listed.status, 200);
  const list = (await listed.json()) as {
    links: Array<Record<string, unknown>>;
  };
  assert.equal(list.links.length, 3);
  const first = list.links.find((row) => row.id === id);
  assert.ok(first);
  assert.equal(first.open_count, 1);
  assert.equal(first.view_count, 1);
  assert.ok(Number(first.last_opened_at) > 0);
  assert.equal(first.passcode, undefined);
  assert.equal(first.password_hash, undefined);
  assert.ok(list.links.every((row) => typeof row.url === "string"));
  assert.equal(state.viewWrites.length, 1);

  const revoked = await handleAdminApi(
    apiRequest(`${base}/${id}`, { method: "DELETE" }),
    env,
    `${base}/${id}`,
  );
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true, id, state: "revoked" });
  const again = await handleAdminApi(
    apiRequest(`${base}/${id}`, { method: "DELETE" }),
    env,
    `${base}/${id}`,
  );
  assert.equal(again.status, 404);
  const afterRevoke = (await (
    await handleAdminApi(apiRequest(base), env, base)
  ).json()) as {
    links: Array<Record<string, unknown>>;
  };
  assert.equal(
    afterRevoke.links.find((row) => row.id === id)?.state,
    "revoked",
  );
});

test("stats never carry the passcode hash or salt", async () => {
  const { env } = linkState(gateArtifact(), [
    await passwordLink("pwlink0000000001", "open-sesame"),
  ]);
  const path = "/api/v1/artifacts/gate-demo-abc123/stats";
  const response = await handleAdminApi(apiRequest(path), env, path);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /password_hash|password_salt/);
  assert.match(text, /"kind":"password"/);
});

test("artifact_manage share_link, share_links and revoke_link ride the same routes", async () => {
  const { env, store } = linkState(gateArtifact());
  const call = async (args: Record<string, unknown>) => {
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "artifact_manage",
            arguments: { artifact: "gate-demo-abc123", ...args },
          },
        }),
      }),
      env,
    );
    return (
      (await response.json()) as {
        result: {
          structuredContent: Record<string, unknown>;
          isError?: boolean;
        };
      }
    ).result;
  };
  const created = await call({
    action: "share_link",
    kind: "open",
    label: "Anyone",
    max_opens: 10,
  });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.kind, "open");
  assert.match(String(created.structuredContent.url), /\?v=/);
  const id = String(created.structuredContent.id);
  const listed = await call({ action: "share_links" });
  assert.equal((listed.structuredContent.links as unknown[]).length, 1);
  const missing = await call({ action: "revoke_link" });
  assert.equal(missing.isError, true);
  const revoked = await call({ action: "revoke_link", link_id: id });
  assert.equal(revoked.structuredContent.state, "revoked");
  assert.ok(store.get(id)?.revoked_at);
});

test("access_preset is an alias for the gate level, never a new level", async () => {
  const updates: unknown[][] = [];
  const { env } = linkState(gateArtifact());
  const original = env.DB.prepare.bind(env.DB);
  (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const statement = original(sql) as {
      run: () => Promise<unknown>;
      bind: (...v: unknown[]) => unknown;
    };
    if (sql.startsWith("UPDATE artifacts SET title = COALESCE")) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        updates.push(values);
        return bind(...values);
      };
    }
    return statement;
  };
  const path = "/api/v1/artifacts/gate-demo-abc123";
  const response = await handleAdminApi(
    apiRequest(path, {
      method: "PATCH",
      body: JSON.stringify({ access_preset: "client" }),
    }),
    env,
    path,
  );
  assert.equal(response.status, 200);
  assert.equal(updates[0]?.[1], "verified_email");
  const bad = await handleAdminApi(
    apiRequest(path, {
      method: "PATCH",
      body: JSON.stringify({ access_preset: "vip" }),
    }),
    env,
    path,
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_access_preset");
});
