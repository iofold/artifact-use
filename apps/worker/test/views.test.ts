import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { issueAdminCsrfToken, signPayload } from "../src/auth.ts";
import { handleGateRoute } from "../src/gate.ts";
import type { ShareLink } from "../src/links.ts";
import { handleAdminUiApi } from "../src/publisher.ts";
import { servePublic } from "../src/serve.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
  PublisherSession,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import { type ViewKind, classifyViewer, seenCookieName } from "../src/views.ts";

const ORIGIN = "https://artifacts.example.com";
const ARTIFACT_PATH = "/go/gate-demo-abc123/";
const HTML =
  "<!doctype html><html><head></head><body>public body</body></html>";
const CSS = "body{color:teal}";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// ---- classification --------------------------------------------------------

// One row per family named in the roadmap, plus the browsers that must stay
// human. The migration backfill is checked against the same table below.
const UA_TABLE: Array<[family: string, ua: string, kind: ViewKind]> = [
  ["desktop Chrome", CHROME, "human"],
  [
    "iPhone Safari",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "human",
  ],
  [
    "Firefox",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0",
    "human",
  ],
  [
    "headless Chrome",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36",
    "automation",
  ],
  ["curl", "curl/8.7.1", "automation"],
  ["python-requests", "python-requests/2.32.3", "automation"],
  ["python-httpx", "python-httpx2/2.7.0", "automation"],
  ["python-urllib", "Python-urllib/3.12", "automation"],
  ["aiohttp", "Python/3.12 aiohttp/3.9.5", "automation"],
  ["node", "node", "automation"],
  [
    "node-fetch",
    "node-fetch/1.0 (+https://github.com/node-fetch)",
    "automation",
  ],
  ["undici", "undici", "automation"],
  ["Bun", "Bun/1.3.10", "automation"],
  ["Go", "Go-http-client/2.0", "automation"],
  ["wget", "Wget/1.21.4", "automation"],
  [
    "Slackbot",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "automation",
  ],
  [
    "facebookexternalhit",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "automation",
  ],
  ["Twitterbot", "Twitterbot/1.0", "automation"],
  ["WhatsApp", "WhatsApp/2.23.20.0", "automation"],
  ["TelegramBot", "TelegramBot (like TwitterBot)", "automation"],
  [
    "Discordbot",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "automation",
  ],
  [
    "LinkedInBot",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "automation",
  ],
  ["empty", "", "automation"],
  ["claude-code", "claude-code/2.1.280 (external, cli)", "agent"],
  ["codex", "codex-mcp-client/0.156.0", "agent"],
  ["Claude-User", "Claude-User/1.0", "agent"],
  [
    "ChatGPT-User",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "agent",
  ],
  ["hermes", "Hermes-Agent/1.0", "agent"],
  ["opencode", "opencode/1.2.3", "agent"],
  ["cursor", "Cursor/1.4.0", "agent"],
  ["kiro", "kiro/0.9.0", "agent"],
  ["Hypermodel", "Hypermodel-Claims-Review-Admin/1.0", "agent"],
];

test("classifyViewer sorts every observed family into human, agent or automation", () => {
  for (const [family, ua, kind] of UA_TABLE)
    assert.equal(classifyViewer(ua), kind, family);
  assert.equal(classifyViewer(null), "automation", "missing header");
});

// ---- migration -------------------------------------------------------------

const MIGRATION = readFileSync(
  new URL("../migrations/0017_view_kinds.sql", import.meta.url),
  "utf8",
);

// SQLite LIKE is case-insensitive for ASCII; % and _ are its wildcards.
function likeToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("")
    .map((ch) =>
      ch === "%"
        ? ".*"
        : ch === "_"
          ? "."
          : ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "i");
}

// Replays the backfill's UPDATE statements over a User-Agent the way SQLite
// would: each statement's predicates are OR-ed, statements run in order and
// the last match wins, and an untouched row keeps the column default.
function backfillKind(ua: string | null): ViewKind {
  let kind: ViewKind = "human";
  for (const statement of MIGRATION.split(";")) {
    const match = /UPDATE views SET kind = '(\w+)' WHERE ([\s\S]+)/.exec(
      statement,
    );
    if (!match) continue;
    const [, target, where] = match;
    const predicates = where!.split(/\bOR\b/i).map((p) => p.trim());
    const hit = predicates.some((predicate) => {
      if (/^ua IS NULL$/i.test(predicate)) return ua === null;
      const eq = /^ua = '([^']*)'$/i.exec(predicate);
      if (eq) return ua === eq[1];
      const like = /^ua LIKE '([^']+)'$/i.exec(predicate);
      if (like) return ua !== null && likeToRegExp(like[1]!).test(ua);
      throw new Error(`unexpected predicate in backfill: ${predicate}`);
    });
    if (hit) kind = target as ViewKind;
  }
  return kind;
}

test("migration 0017 adds kind, source and the (artifact, kind, ts) index", () => {
  assert.match(
    MIGRATION,
    /ALTER TABLE views ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';/,
  );
  assert.match(MIGRATION, /ALTER TABLE views ADD COLUMN source TEXT;/);
  assert.match(
    MIGRATION,
    /CREATE INDEX IF NOT EXISTS \w+\s+ON views\(artifact_id, kind, ts\);/,
  );
  assert.match(
    MIGRATION,
    /UPDATE views SET source = CASE\s+WHEN share_link_id IS NOT NULL THEN 'link'\s+ELSE 'gate'\s+END WHERE source IS NULL;/,
  );
});

test("migration 0017's backfill agrees with classifyViewer on every family", () => {
  for (const [family, ua, kind] of UA_TABLE)
    assert.equal(backfillKind(ua), kind, `backfill: ${family}`);
  assert.equal(backfillKind(null), "automation", "backfill: NULL ua");
});

// ---- public views ----------------------------------------------------------

function artifactRow(gateLevel: Artifact["gate_level"] = "public"): Artifact {
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
  file_count: 2,
  created_by: "user_gate",
  created_at: 1,
  completed_at: 1,
};

const files: Record<string, ArtifactFile> = {
  "index.html": {
    version_id: "ver_gate",
    path: "index.html",
    storage_key: "k/index.html",
    content_type: "text/html; charset=utf-8",
    size: HTML.length,
    sha256: null,
    uploaded_at: 1,
  },
  "page2.html": {
    version_id: "ver_gate",
    path: "page2.html",
    storage_key: "k/page2.html",
    content_type: "text/html; charset=utf-8",
    size: HTML.length,
    sha256: null,
    uploaded_at: 1,
  },
  "style.css": {
    version_id: "ver_gate",
    path: "style.css",
    storage_key: "k/style.css",
    content_type: "text/css; charset=utf-8",
    size: CSS.length,
    sha256: null,
    uploaded_at: 1,
  },
};

function openLink(id: string): ShareLink {
  return {
    id,
    artifact_id: "art_gate",
    kind: "open",
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
  };
}

// A fake D1/R2 pair: serves two HTML pages and a stylesheet, records every
// INSERT INTO views, and answers the membership lookups the publisher
// session check makes.
function viewState(
  artifact: Artifact,
  options: {
    memberships?: Array<{ org_id: string }>;
    links?: ShareLink[];
    failInsert?: boolean;
  } = {},
) {
  const state = { viewWrites: [] as unknown[][], bucketReads: 0 };
  const links = new Map((options.links || []).map((l) => [l.id, l]));
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("INSERT INTO rate_counters")) return { count: 1 };
          if (sql.includes("FROM share_links WHERE id = ? AND artifact_id = ?"))
            return links.get(String(statement.values[0])) || null;
          if (sql.includes("FROM creator_tokens"))
            return { revoked_at: null, last_used_at: null };
          if (sql.includes("FROM artifact_versions")) return version;
          if (sql.includes("FROM artifact_files")) {
            const path = statement.values.find(
              (v) => typeof v === "string" && v in files,
            );
            return path ? files[path as string] : null;
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
          if (sql.includes("INSERT INTO views")) {
            if (options.failInsert) throw new Error("D1 unavailable");
            state.viewWrites.push(statement.values);
            return {
              meta: { changes: 1, last_row_id: state.viewWrites.length },
            };
          }
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
  };
  const object = (body: string, contentType: string) => ({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    size: body.length,
    uploaded: new Date(0),
    httpEtag: '"views-test"',
    httpMetadata: { contentType },
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", contentType);
    },
    async text() {
      return body;
    },
  });
  const env = {
    DB: db,
    BUCKET: {
      async get(key: string) {
        state.bucketReads += 1;
        return key.endsWith(".css")
          ? object(CSS, "text/css; charset=utf-8")
          : object(HTML, "text/html; charset=utf-8");
      },
      async head() {
        return null;
      },
    },
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "views-test-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_gate",
    DEV_AUTH_ORG_ID: artifact.org_id,
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  return { env, state };
}

function browser(
  url: string,
  init: RequestInit & { ua?: string; cookie?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/html,application/xhtml+xml");
  headers.set("User-Agent", init.ua ?? CHROME);
  headers.set("CF-Connecting-IP", "203.0.113.9");
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(url, { ...init, headers });
}

async function publisherCookie(
  env: Env,
  overrides: Partial<PublisherSession> = {},
): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_member",
    orgId: "org_gate",
    email: "member@example.com",
    name: "Member",
    exp: nowSec() + 600,
    ...overrides,
  };
  return `au_pub=${encodeURIComponent(await signPayload(session, env))}`;
}

const SEEN = seenCookieName("art_gate");

test("a person's first load of a public page records one anonymous human view and sets the seen cookie", async () => {
  const { env, state } = viewState(artifactRow("public"));
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /public body/);
  assert.equal(state.viewWrites.length, 1);
  const row = state.viewWrites[0]!;
  assert.equal(row[0], "art_gate");
  assert.equal(row[1], "ver_gate");
  assert.equal(row[2], null, "no share link");
  assert.equal(row[4], 0, "unverified");
  assert.equal(typeof row[5], "string", "ip hash present");
  assert.equal(row[3], `public:${row[5]}`, "identity is the ip hash");
  assert.equal(row[6], CHROME);
  assert.equal(row[9], "human");
  assert.equal(row[10], "public");
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SEEN}=`));
  assert.ok(cookie, "seen cookie set");
  assert.equal(SEEN, "au_seen_art_gate");
  assert.equal(
    cookie,
    `${SEEN}=1; Path=${ARTIFACT_PATH}; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
  );
});

test("the seen cookie suppresses a second view for the window, on every page of the artifact", async () => {
  const { env, state } = viewState(artifactRow("public"));
  for (const path of [ARTIFACT_PATH, `${ARTIFACT_PATH}page2.html`]) {
    const response = await servePublic(
      browser(`${ORIGIN}${path}`, { cookie: `${SEEN}=1` }),
      env,
      path,
    );
    assert.equal(response.status, 200, path);
    assert.equal(
      response.headers.getSetCookie().length,
      0,
      `${path}: no cookie re-issued`,
    );
  }
  assert.equal(state.viewWrites.length, 0);
  // Without the cookie a second HTML page counts (once).
  const fresh = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}page2.html`),
    env,
    `${ARTIFACT_PATH}page2.html`,
  );
  assert.equal(fresh.status, 200);
  assert.equal(state.viewWrites.length, 1);
});

test("agents, automation, assets, HEAD and token reads never create a public view", async () => {
  const { env, state } = viewState(artifactRow("public"));
  const cases: Array<[string, Request]> = [
    [
      "claude-code",
      browser(`${ORIGIN}${ARTIFACT_PATH}`, {
        ua: "claude-code/2.1.280 (external, cli)",
      }),
    ],
    [
      "headless Chrome",
      browser(`${ORIGIN}${ARTIFACT_PATH}`, {
        ua: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/147.0.0.0 Safari/537.36",
      }),
    ],
    ["curl", browser(`${ORIGIN}${ARTIFACT_PATH}`, { ua: "curl/8.7.1" })],
    ["empty UA", browser(`${ORIGIN}${ARTIFACT_PATH}`, { ua: "" })],
    [
      "stylesheet",
      browser(`${ORIGIN}${ARTIFACT_PATH}style.css`, {
        headers: { Accept: "text/css,*/*;q=0.1" },
      }),
    ],
    ["HEAD", browser(`${ORIGIN}${ARTIFACT_PATH}`, { method: "HEAD" })],
    [
      "creator token",
      browser(`${ORIGIN}${ARTIFACT_PATH}`, {
        headers: { Authorization: "Bearer dev-token" },
      }),
    ],
    [
      "non-HTML accept",
      new Request(`${ORIGIN}${ARTIFACT_PATH}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": CHROME,
          "CF-Connecting-IP": "203.0.113.9",
        },
      }),
    ],
  ];
  for (const [label, request] of cases) {
    const path = new URL(request.url).pathname;
    const response = await servePublic(request, env, path);
    assert.equal(response.status, 200, label);
    assert.equal(state.viewWrites.length, 0, `${label}: no view`);
    assert.equal(
      response.headers.getSetCookie().length,
      0,
      `${label}: no seen cookie`,
    );
  }
});

test("the publisher's own signed-in session on a public artifact is not a view; an outsider's is", async () => {
  const member = viewState(artifactRow("public"));
  const own = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`, {
      cookie: await publisherCookie(member.env),
    }),
    member.env,
    ARTIFACT_PATH,
  );
  assert.equal(own.status, 200);
  assert.equal(member.state.viewWrites.length, 0, "member: no view");
  assert.equal(own.headers.getSetCookie().length, 0);

  // Membership through the multi-workspace snapshot counts as the publisher.
  const snapshot = viewState(artifactRow("public"), {
    memberships: [{ org_id: "org_gate" }],
  });
  await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`, {
      cookie: await publisherCookie(snapshot.env, { orgId: "org_other" }),
    }),
    snapshot.env,
    ARTIFACT_PATH,
  );
  assert.equal(snapshot.state.viewWrites.length, 0, "snapshot member");

  // A publisher from an unrelated workspace is a person looking.
  const outsider = viewState(artifactRow("public"));
  const theirs = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`, {
      cookie: await publisherCookie(outsider.env, { orgId: "org_other" }),
    }),
    outsider.env,
    ARTIFACT_PATH,
  );
  assert.equal(theirs.status, 200);
  assert.equal(outsider.state.viewWrites.length, 1, "outsider: one view");
});

test("a failed insert leaves the page and the cookie alone so the next load retries", async () => {
  const { env, state } = viewState(artifactRow("public"), {
    failInsert: true,
  });
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /public body/);
  assert.equal(state.viewWrites.length, 0);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("gated artifacts never take the public path: a session read adds no row and no seen cookie", async () => {
  const { env, state } = viewState(artifactRow("email"));
  const session: ViewerSession = {
    artifact_id: "art_gate",
    version_id: "ver_gate",
    email: "viewer@example.com",
    verified: false,
    view_id: 1,
    exp: nowSec() + 600,
  };
  const response = await servePublic(
    browser(`${ORIGIN}${ARTIFACT_PATH}`, {
      cookie: `au_art_gate=${encodeURIComponent(await signPayload(session, env))}`,
    }),
    env,
    ARTIFACT_PATH,
  );
  assert.equal(response.status, 200);
  assert.equal(state.viewWrites.length, 0);
  assert.equal(response.headers.getSetCookie().length, 0);
});

// ---- gate passes carry kind and source -------------------------------------

test("a gate pass tags the row with the viewer's kind and how it got in", async () => {
  // A share link used by curl: automation, via link.
  const linked = viewState(artifactRow("email"), {
    links: [openLink("openlink00000001")],
  });
  const viaLink = await handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/link`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "User-Agent": "curl/8.7.1",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        link: "openlink00000001",
      }),
    }),
    linked.env,
    "/_au/gate/link",
  );
  assert.equal(viaLink.status, 200);
  assert.equal(linked.state.viewWrites.length, 1);
  assert.equal(linked.state.viewWrites[0]?.[2], "openlink00000001");
  assert.equal(linked.state.viewWrites[0]?.[9], "automation");
  assert.equal(linked.state.viewWrites[0]?.[10], "link");

  // A signed-in member consenting on the gate page: human, session.
  const consented = viewState(artifactRow("verified_email"));
  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": CHROME,
    "CF-Connecting-IP": "203.0.113.9",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    Referer: `${ORIGIN}${ARTIFACT_PATH}`,
    Cookie: await publisherCookie(consented.env),
  });
  const viaSession = await handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/session`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        redirect_to: ARTIFACT_PATH,
      }),
    }),
    consented.env,
    "/_au/gate/session",
  );
  assert.equal(viaSession.status, 200);
  assert.equal(consented.state.viewWrites.length, 1);
  assert.equal(consented.state.viewWrites[0]?.[3], "member@example.com");
  assert.equal(consented.state.viewWrites[0]?.[4], 1);
  assert.equal(consented.state.viewWrites[0]?.[9], "human");
  assert.equal(consented.state.viewWrites[0]?.[10], "session");
});

// ---- stats and overview JSON -----------------------------------------------

const STATS_ROW = {
  total: 12,
  unique_viewers: 7,
  last_ts: 1758700000,
  people: 9,
  agents: 3,
  unique_people: 5,
  self_reported: 4,
  verified: 3,
  via_link: 1,
  public: 2,
};

test("GET /api/v1/artifacts/{key}/stats splits views by kind and keeps the old fields", async () => {
  const artifact = artifactRow("email");
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        queries.push(sql);
        const statement = {
          bind: () => statement,
          async first() {
            if (sql.includes("FROM creator_tokens"))
              return { revoked_at: null, last_used_at: null };
            if (sql.includes("FROM views WHERE artifact_id = ?"))
              return STATS_ROW;
            if (sql.includes("FROM artifacts")) return artifact;
            return null;
          },
          async all() {
            if (
              sql.includes("SELECT email, verified, kind, source, ts, referrer")
            )
              return {
                results: [
                  {
                    email: "public:abc",
                    verified: 0,
                    kind: "human",
                    source: "public",
                    ts: 1758700000,
                    referrer: null,
                  },
                ],
              };
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        };
        return statement;
      },
    },
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "views-test-secret",
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_gate",
    DEV_AUTH_ORG_ID: "org_gate",
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  const path = "/api/v1/artifacts/gate-demo-abc123/stats";
  const response = await handleAdminApi(
    new Request(`${ORIGIN}${path}`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    path,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    views: Record<string, number | null>;
    recent: Array<Record<string, unknown>>;
  };
  assert.deepEqual(body.views, STATS_ROW);
  assert.equal(body.recent[0]?.kind, "human");
  assert.equal(body.recent[0]?.source, "public");
  const statsSql = queries.find((sql) =>
    sql.includes("FROM views WHERE artifact_id = ?"),
  );
  assert.ok(statsSql);
  // People are humans; agents are everything else; no email domain is named.
  assert.match(statsSql, /kind = 'human'/);
  assert.match(statsSql, /source = 'public'/);
  assert.doesNotMatch(statsSql, /@|LIKE/);
});

test("the admin overview reports people and agents separately for totals, rows, days and recent views", async () => {
  const artifact = artifactRow("public");
  const today = new Date().toISOString().slice(0, 10);
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          async first() {
            if (sql.includes("workspace_membership_sync"))
              return { refreshed_at: nowSec() };
            if (sql.includes("v.ts >= ?") && sql.includes("AS people"))
              return { n: 5, people: 3 };
            if (sql.includes("COUNT(DISTINCT v.email) AS n"))
              return { n: 7, people: 5 };
            return null;
          },
          async all() {
            if (sql.includes("GROUP BY a.id"))
              return {
                results: [
                  {
                    ...artifact,
                    total_views: 12,
                    unique_viewers: 7,
                    views_people: 9,
                    views_agents: 3,
                    unique_people: 5,
                    last_view_ts: 1758700000,
                    share_links: 0,
                    comment_count: 0,
                    open_comments: 0,
                    file_count: 1,
                    total_size: 10,
                    completed_at: 1,
                  },
                ],
              };
            if (sql.includes("GROUP BY v.artifact_id, day"))
              return {
                results: [
                  {
                    artifact_id: "art_gate",
                    day: today,
                    n: 5,
                    people: 3,
                    agents: 2,
                  },
                ],
              };
            if (sql.includes("ORDER BY v.ts DESC"))
              return {
                results: [
                  {
                    artifact_id: "art_gate",
                    slug: "gate-demo",
                    url_key: "gate-demo-abc123",
                    title: "Gate demo",
                    email: "public:abc",
                    verified: 0,
                    share_link_id: null,
                    kind: "human",
                    source: "public",
                    ts: 1758700000,
                    referrer: null,
                  },
                  {
                    artifact_id: "art_gate",
                    slug: "gate-demo",
                    url_key: "gate-demo-abc123",
                    title: "Gate demo",
                    email: "qa@example.com",
                    verified: 0,
                    share_link_id: null,
                    kind: "automation",
                    source: "gate",
                    ts: 1758690000,
                    referrer: null,
                  },
                ],
              };
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        };
        return statement;
      },
    },
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "views-test-secret",
  } as unknown as Env;
  const exp = nowSec() + 600;
  const raw = await signPayload(
    {
      typ: "publisher",
      sub: "user_gate",
      orgId: "org_gate",
      email: "publisher@example.com",
      name: "Publisher",
      exp,
    } satisfies PublisherSession,
    env,
  );
  const csrf = await issueAdminCsrfToken(raw, exp, env);
  const response = await handleAdminUiApi(
    new Request(`${ORIGIN}/admin/api/overview`, {
      headers: {
        Accept: "application/json",
        Cookie: `au_pub=${encodeURIComponent(raw)}; au_admin_csrf=${encodeURIComponent(csrf.token)}`,
        "X-CSRF-Token": csrf.token,
      },
    }),
    env,
    "/admin/api/overview",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    totals: Record<string, number>;
    artifacts: Array<Record<string, unknown>>;
    daily: Array<Record<string, unknown>>;
    recent: Array<Record<string, unknown>>;
  };
  assert.equal(body.totals.views, 12);
  assert.equal(body.totals.views_people, 9);
  assert.equal(body.totals.views_agents, 3);
  assert.equal(body.totals.viewers, 7);
  assert.equal(body.totals.unique_people, 5);
  assert.equal(body.totals.views7d, 5);
  assert.equal(body.totals.views7d_people, 3);
  assert.equal(body.artifacts[0]?.total_views, 12);
  assert.equal(body.artifacts[0]?.views_people, 9);
  assert.equal(body.artifacts[0]?.views_agents, 3);
  assert.equal(body.artifacts[0]?.unique_people, 5);
  assert.deepEqual(body.daily, [
    { artifact_id: "art_gate", day: today, n: 5, people: 3, agents: 2 },
  ]);
  assert.equal(body.recent[0]?.kind, "human");
  assert.equal(body.recent[0]?.source, "public");
  assert.equal(body.recent[0]?.verified, false);
  assert.equal(body.recent[1]?.kind, "automation");
  assert.equal(body.recent[1]?.source, "gate");
});
