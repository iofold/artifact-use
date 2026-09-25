import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin.ts";
import { signPayload } from "../src/auth.ts";
import { handleMcp } from "../src/mcp.ts";
import { handlePublish } from "../src/publish.ts";
import { servePublic } from "../src/serve.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
  ViewerSession,
} from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import {
  DIFF_MAX_FILES,
  DIFF_MAX_FILE_BYTES,
  DIFF_MAX_TOTAL_BYTES,
} from "../src/versions.ts";

const ORIGIN = "https://artifacts.example.com";
const KEY = "ver-demo-abc123";
const PATH = `/go/${KEY}/`;
const OLD_HTML =
  "<!doctype html><html><head></head><body><h1>old page</h1></body></html>";
const NEW_HTML =
  "<!doctype html><html><head></head><body><h1>new page</h1></body></html>";

type StoredFile = ArtifactFile & { text: string };

function versionRow(
  id: string,
  overrides: Partial<ArtifactVersion> = {},
): ArtifactVersion {
  return {
    id,
    artifact_id: "art_ver",
    org_id: "org_ver",
    status: "complete",
    entrypoint: "index.html",
    manifest_json: null,
    total_size: 0,
    file_count: 0,
    created_by: "user_ver",
    created_at: 100,
    completed_at: 100,
    ...overrides,
  };
}

function fileRow(
  versionId: string,
  path: string,
  text: string,
  overrides: Partial<ArtifactFile> = {},
): StoredFile {
  return {
    version_id: versionId,
    path,
    storage_key: `orgs/org_ver/artifacts/art_ver/versions/${versionId}/files/${path}`,
    content_type: path.endsWith(".html")
      ? "text/html; charset=utf-8"
      : path.endsWith(".css")
        ? "text/css; charset=utf-8"
        : path.endsWith(".js")
          ? "application/javascript; charset=utf-8"
          : path.endsWith(".png")
            ? "image/png"
            : "text/plain; charset=utf-8",
    size: new TextEncoder().encode(text).byteLength,
    sha256: `sha-${path}-${hashish(text)}`,
    uploaded_at: 1,
    text,
    ...overrides,
  };
}

// A stable stand-in for a content hash: equal texts hash equal.
function hashish(text: string): string {
  let h = 7;
  for (let i = 0; i < text.length; i += 1)
    h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// The two-version fixture most tests start from: ver_old (index.html,
// app.css, removed.txt, logo.png) then ver_new (index.html changed, app.css
// identical, added.js, logo.png changed), plus an unfinished draft.
function fixture(): {
  versions: ArtifactVersion[];
  files: StoredFile[];
} {
  return {
    versions: [
      versionRow("ver_old", { created_at: 100, completed_at: 100 }),
      versionRow("ver_new", { created_at: 200, completed_at: 200 }),
      versionRow("ver_draft", {
        status: "draft",
        created_at: 300,
        completed_at: null,
      }),
      versionRow("ver_other", {
        artifact_id: "art_other",
        org_id: "org_ver",
        created_at: 250,
      }),
    ],
    files: [
      fileRow("ver_old", "index.html", OLD_HTML),
      fileRow("ver_old", "app.css", "body{color:red}\n"),
      fileRow("ver_old", "removed.txt", "gone\n"),
      fileRow("ver_old", "logo.png", "PNG-1", { sha256: "sha-png-1" }),
      fileRow("ver_new", "index.html", NEW_HTML),
      fileRow("ver_new", "app.css", "body{color:red}\n"),
      fileRow("ver_new", "added.js", "console.log(1)\n"),
      fileRow("ver_new", "logo.png", "PNG-2", { sha256: "sha-png-2" }),
    ],
  };
}

// A fake D1/R2 pair that keeps artifact, versions and files in maps so
// promote, publish and serve round-trip the way the real tables would.
function state(
  options: {
    gateLevel?: Artifact["gate_level"];
    versions?: ArtifactVersion[];
    files?: StoredFile[];
    current?: string | null;
  } = {},
) {
  const fx = fixture();
  const artifact: Artifact = {
    id: "art_ver",
    org_id: "org_ver",
    slug: "ver-demo",
    url_key: KEY,
    title: "Version demo",
    description: "A demo.",
    gate_level: options.gateLevel || "email",
    allowlist_json: null,
    current_version_id:
      options.current === undefined ? "ver_new" : options.current,
    created_by: "user_ver",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
  const versions = new Map(
    (options.versions || fx.versions).map((v) => [v.id, { ...v }]),
  );
  const files = new Map<string, StoredFile[]>();
  for (const file of options.files || fx.files) {
    if (!files.has(file.version_id)) files.set(file.version_id, []);
    files.get(file.version_id)!.push({ ...file });
  }
  const bucket = new Map<string, string>();
  for (const list of files.values())
    for (const file of list) bucket.set(file.storage_key, file.text);
  const st = {
    artifact,
    versions,
    files,
    bucket,
    writes: [] as string[],
    bucketWrites: [] as string[],
    bucketReads: [] as string[],
    views: 0,
  };
  const strip = (file: StoredFile): ArtifactFile => {
    const { text: _t, ...row } = file;
    return row;
  };
  const db = {
    prepare(sql: string) {
      const statement = {
        query: sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          const v = statement.values;
          if (sql.includes("FROM legacy_artifact_paths")) return null;
          if (sql.includes("FROM artifacts a")) {
            if (sql.includes("a.url_key = ?"))
              return v[0] === artifact.url_key ? artifact : null;
            if (sql.includes("a.org_id = ? AND a.slug = ?"))
              return v[0] === artifact.org_id && v[1] === artifact.slug
                ? artifact
                : null;
            if (sql.includes("a.id = ?"))
              return v[0] === artifact.id ? artifact : null;
            return null;
          }
          if (sql.includes("FROM artifacts WHERE id = ?"))
            return v[0] === artifact.id ? artifact : null;
          if (sql.includes("org_suspensions")) return null;
          if (sql.includes("INSERT INTO rate_counters")) return { count: 1 };
          if (sql.includes("FROM share_links")) return null;
          if (sql.includes("FROM artifact_versions")) {
            const row = versions.get(String(v[0])) || null;
            if (!row) return null;
            if (sql.includes("artifact_id = ?"))
              return row.artifact_id === v[1] ? row : null;
            if (sql.includes("org_id = ?"))
              return row.org_id === v[1] ? row : null;
            return row;
          }
          if (sql.includes("FROM artifact_files")) {
            const row = (files.get(String(v[0])) || []).find(
              (f) => f.path === v[1],
            );
            return row ? strip(row) : null;
          }
          return null;
        },
        async all() {
          const v = statement.values;
          if (sql.includes("FROM artifact_versions")) {
            const rows = [...versions.values()].filter(
              (row) =>
                row.artifact_id === v[0] &&
                (!sql.includes("status = 'complete'") ||
                  row.status === "complete"),
            );
            rows.sort(
              (a, b) => b.created_at - a.created_at || (b.id < a.id ? -1 : 1),
            );
            return { results: rows };
          }
          if (sql.includes("FROM artifact_files")) {
            const rows = (files.get(String(v[0])) || [])
              .map(strip)
              .sort((a, b) => a.path.localeCompare(b.path));
            return { results: rows };
          }
          if (sql.includes("FROM artifacts a")) return { results: [artifact] };
          return { results: [] };
        },
        async run() {
          const v = statement.values;
          st.writes.push(sql);
          if (sql.startsWith("UPDATE artifacts SET current_version_id")) {
            artifact.current_version_id = String(v[0]);
            artifact.updated_at = Number(v[1]);
          } else if (sql.startsWith("UPDATE artifacts SET title")) {
            artifact.updated_at = Number(v[3]);
          } else if (sql.startsWith("INSERT INTO artifact_versions")) {
            versions.set(String(v[0]), {
              id: String(v[0]),
              artifact_id: String(v[1]),
              org_id: String(v[2]),
              status: "draft",
              entrypoint: String(v[3]),
              manifest_json: null,
              total_size: 0,
              file_count: 0,
              created_by: String(v[4]),
              created_at: Number(v[5]),
              completed_at: null,
            });
          } else if (sql.startsWith("INSERT INTO artifact_files")) {
            const versionId = String(v[0]);
            const version = versions.get(versionId);
            if (!version || version.status !== "draft")
              return { meta: { changes: 0 } };
            const list = files.get(versionId) || [];
            files.set(versionId, [
              ...list.filter((f) => f.path !== v[1]),
              {
                version_id: versionId,
                path: String(v[1]),
                storage_key: String(v[2]),
                content_type: String(v[3]),
                size: Number(v[4]),
                sha256: (v[5] as string) || null,
                uploaded_at: Number(v[6]),
                text: bucket.get(String(v[2])) || "",
              },
            ]);
          } else if (sql.includes("INSERT INTO views")) {
            st.views += 1;
            return { meta: { changes: 1, last_row_id: st.views } };
          }
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      for (const s of statements) {
        st.writes.push(s.query);
        if (
          s.query.startsWith("UPDATE artifact_versions SET status = 'complete'")
        ) {
          const version = versions.get(String(s.values[4]));
          if (version) {
            version.status = "complete";
            version.manifest_json = String(s.values[0]);
            version.total_size = Number(s.values[1]);
            version.file_count = Number(s.values[2]);
            version.completed_at = Number(s.values[3]);
          }
        } else if (
          s.query.startsWith("UPDATE artifacts SET current_version_id")
        ) {
          artifact.current_version_id = String(s.values[0]);
          artifact.updated_at = Number(s.values[1]);
        }
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const object = (key: string) => {
    const text = bucket.get(key);
    if (text === undefined) return null;
    const bytes = new TextEncoder().encode(text);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      size: bytes.byteLength,
      uploaded: new Date(0),
      httpEtag: `"${hashish(text)}"`,
      httpMetadata: {},
      writeHttpMetadata() {},
      async text() {
        return text;
      },
    };
  };
  const env = {
    DB: db,
    BUCKET: {
      async get(key: string) {
        st.bucketReads.push(key);
        return object(key);
      },
      async head(key: string) {
        return object(key);
      },
      async put(key: string, body: unknown) {
        const text =
          body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : await new Response(body as BodyInit).text();
        bucket.set(key, text);
        st.bucketWrites.push(key);
        return { size: new TextEncoder().encode(text).byteLength };
      },
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    },
    SITE_BASE_URL: ORIGIN,
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "versions-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_ver",
    DEV_AUTH_ORG_ID: "org_ver",
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  // Returned by reference so counters stay live after the call.
  return Object.assign(st, { env });
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

function creator(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer dev-token");
  headers.set("Content-Type", "application/json");
  return new Request(`${ORIGIN}${url}`, { ...init, headers });
}

async function viewerCookie(env: Env): Promise<string> {
  const session: ViewerSession = {
    artifact_id: "art_ver",
    version_id: "ver_new",
    email: "viewer@example.com",
    verified: false,
    view_id: 1,
    exp: nowSec() + 600,
  };
  return `au_art_ver=${encodeURIComponent(await signPayload(session, env))}`;
}

async function mcp(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}> {
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
        params: { name, arguments: args },
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
}

// ---- list -----------------------------------------------------------------

test("the versions list is newest first, complete only, with the current one marked", async () => {
  const { env } = state();
  const path = `/api/v1/artifacts/${KEY}/versions`;
  const response = await handleAdminApi(creator(path), env, path);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    versions: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    body.versions.map((v) => [v.id, v.current]),
    [
      ["ver_new", true],
      ["ver_old", false],
    ],
  );
  const newest = body.versions[0]!;
  assert.equal(newest.url, `${ORIGIN}/go/${KEY}/_v/ver_new/`);
  assert.equal(newest.created_at, 200);
  assert.equal(newest.completed_at, 200);
  assert.equal(newest.entrypoint, "index.html");
  assert.equal(newest.created_by, "user_ver");
  assert.equal(typeof newest.file_count, "number");
  assert.equal(typeof newest.total_size, "number");

  const tool = await mcp(env, "artifact_manage", {
    action: "versions",
    artifact: KEY,
  });
  assert.equal(tool.isError, undefined);
  assert.equal(
    (tool.structuredContent.versions as Array<{ id: string }>).length,
    2,
  );
});

test("artifact list and detail carry links for the current version", async () => {
  const { env } = state();
  const list = await handleAdminApi(
    creator("/api/v1/artifacts"),
    env,
    "/api/v1/artifacts",
  );
  const body = (await list.json()) as {
    artifacts: Array<{ links: Record<string, string> }>;
  };
  assert.deepEqual(body.artifacts[0]?.links, {
    artifact: `${ORIGIN}/go/${KEY}/`,
    version: `${ORIGIN}/go/${KEY}/_v/ver_new/`,
    review: `${ORIGIN}/go/${KEY}/`,
  });
  const detail = await handleAdminApi(
    creator(`/api/v1/artifacts/${KEY}`),
    env,
    `/api/v1/artifacts/${KEY}`,
  );
  assert.equal(
    ((await detail.json()) as { links: { version: string } }).links.version,
    `${ORIGIN}/go/${KEY}/_v/ver_new/`,
  );
});

// ---- serving a prior version ----------------------------------------------

test("a creator token reads a prior version at its _v/ URL, assets included", async () => {
  const { env, views } = state();
  const page = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/ver_old/`,
  );
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("X-Artifact-Version"), "ver_old");
  assert.match(page.headers.get("X-Robots-Tag") || "", /noindex/);
  assert.match(
    page.headers.get("Link") || "",
    /_v\/ver_old\/_au\/index\.json>; rel="describedby"/,
  );
  const html = await page.text();
  assert.match(html, /old page/);
  // Agents get clean HTML: no banner, no widget.
  assert.doesNotMatch(html, /au-version-banner/);
  assert.doesNotMatch(html, /__AU_FEEDBACK__/);
  assert.equal(views, 0);

  // A file that only the old version has resolves within that version.
  const removed = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/removed.txt`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/ver_old/removed.txt`,
  );
  assert.equal(removed.status, 200);
  assert.equal(await removed.text(), "gone\n");
  assert.equal(removed.headers.get("X-Artifact-Version"), "ver_old");
  const missing = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/added.js`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/ver_old/added.js`,
  );
  assert.equal(missing.status, 404);

  // The stable URL still serves the current version.
  const current = await servePublic(
    agent(`${ORIGIN}${PATH}`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    PATH,
  );
  assert.equal(current.headers.get("X-Artifact-Version"), "ver_new");
  assert.match(await current.text(), /new page/);

  // The descriptor under _v/ describes that version.
  const descriptor = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/_au/index.json`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/ver_old/_au/index.json`,
  );
  assert.equal(descriptor.status, 200);
  const described = (await descriptor.json()) as Record<string, unknown>;
  assert.equal(described.version_id, "ver_old");
  assert.equal(described.current_version_id, "ver_new");
  assert.equal(described.base, `${ORIGIN}${PATH}_v/ver_old/`);
});

test("a browser with a viewer session sees the banner strip and a widget pinned to that version", async () => {
  const { env } = state();
  const cookie = await viewerCookie(env);
  const page = await servePublic(
    browser(`${ORIGIN}${PATH}_v/ver_old/`, { headers: { Cookie: cookie } }),
    env,
    `${PATH}_v/ver_old/`,
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /old page/);
  assert.match(
    html,
    /<body><div id="au-version-banner" data-au-version="ver_old"/,
  );
  assert.match(
    html,
    /Viewing version from <time datetime="1970-01-01T00:01:40\.000Z">1970-01-01 00:01 UTC<\/time>/,
  );
  assert.match(html, /this is not the current version/);
  assert.match(
    html,
    new RegExp(`<a href="${PATH.replace(/\//g, "\\/")}"[^>]*>Open current</a>`),
  );
  // The widget reads this id, so comments posted here carry version_id.
  assert.match(html, /"versionId":"ver_old"/);
  // The banner belongs to prior versions only.
  const current = await servePublic(
    browser(`${ORIGIN}${PATH}`, { headers: { Cookie: cookie } }),
    env,
    PATH,
  );
  const currentHtml = await current.text();
  assert.doesNotMatch(currentHtml, /au-version-banner/);
  assert.match(currentHtml, /"versionId":"ver_new"/);
});

test("the gate applies to prior versions exactly as to the current one", async () => {
  const { env } = state();
  const anonymous = await servePublic(
    browser(`${ORIGIN}${PATH}_v/ver_old/`),
    env,
    `${PATH}_v/ver_old/`,
  );
  assert.equal(anonymous.status, 200);
  const gate = await anonymous.text();
  assert.match(gate, /Enter your email to continue/);
  assert.doesNotMatch(gate, /old page/);
  // The gate sends the viewer back to the version URL they asked for.
  assert.match(
    gate,
    new RegExp(
      `name="redirect_to" value="${PATH.replace(/\//g, "\\/")}_v\\/ver_old\\/"`,
    ),
  );
  const machine = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/`),
    env,
    `${PATH}_v/ver_old/`,
  );
  assert.equal(machine.status, 401);
  assert.equal(
    ((await machine.json()) as { error: { code: string } }).error.code,
    "gate_required",
  );
  // A link session minted on the version URL works there too.
  const linked = state();
  const link = {
    id: "openlink00000001",
    artifact_id: "art_ver",
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
    created_by: "user_ver",
    created_at: 1,
  };
  const original = linked.env.DB.prepare.bind(linked.env.DB);
  (linked.env.DB as { prepare: (sql: string) => unknown }).prepare = (
    sql: string,
  ) => {
    const statement = original(sql) as { first: () => Promise<unknown> };
    if (sql.includes("FROM share_links WHERE id = ? AND artifact_id = ?"))
      statement.first = async () => link;
    return statement;
  };
  const viaLink = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old/?v=openlink00000001`),
    linked.env,
    `${PATH}_v/ver_old/`,
  );
  assert.equal(viaLink.status, 200);
  assert.match(await viaLink.text(), /old page/);
  assert.match(viaLink.headers.get("Set-Cookie") || "", /^au_art_ver=/);
  assert.equal(linked.views, 1);
});

test("an unknown, draft or foreign version under _v/ is a 404", async () => {
  const { env } = state();
  for (const id of ["ver_nope", "ver_draft", "ver_other"]) {
    const response = await servePublic(
      agent(`${ORIGIN}${PATH}_v/${id}/`, {
        headers: { Authorization: "Bearer dev-token" },
      }),
      env,
      `${PATH}_v/${id}/`,
    );
    assert.equal(response.status, 404, id);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "version_not_found",
      id,
    );
  }
  const bare = await servePublic(
    agent(`${ORIGIN}${PATH}_v/`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/`,
  );
  assert.equal(bare.status, 404);
  // Without the trailing slash the version root redirects to it.
  const slashless = await servePublic(
    agent(`${ORIGIN}${PATH}_v/ver_old`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    env,
    `${PATH}_v/ver_old`,
  );
  assert.equal(slashless.status, 301);
  assert.equal(
    slashless.headers.get("Location"),
    `${ORIGIN}${PATH}_v/ver_old/`,
  );
});

// ---- promote / rollback ----------------------------------------------------

test("promoting an older version rolls the stable URL back and returns links", async () => {
  const st = state();
  const path = `/api/v1/artifacts/${KEY}/versions/ver_old/promote`;
  const response = await handleAdminApi(
    creator(path, { method: "POST" }),
    st.env,
    path,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.version_id, "ver_old");
  assert.equal(body.changed, true);
  assert.equal(
    (body.artifact as { current_version_id: string }).current_version_id,
    "ver_old",
  );
  assert.deepEqual(body.links, {
    artifact: `${ORIGIN}/go/${KEY}/`,
    version: `${ORIGIN}/go/${KEY}/_v/ver_old/`,
    review: `${ORIGIN}/go/${KEY}/`,
  });
  assert.equal(st.artifact.current_version_id, "ver_old");
  assert.ok(st.artifact.updated_at > 1);

  const served = await servePublic(
    agent(`${ORIGIN}${PATH}`, {
      headers: { Authorization: "Bearer dev-token" },
    }),
    st.env,
    PATH,
  );
  assert.equal(served.headers.get("X-Artifact-Version"), "ver_old");
  assert.match(await served.text(), /old page/);

  // The newer version stays listed and viewable.
  const list = await handleAdminApi(
    creator(`/api/v1/artifacts/${KEY}/versions`),
    st.env,
    `/api/v1/artifacts/${KEY}/versions`,
  );
  assert.deepEqual(
    (
      (await list.json()) as {
        versions: Array<{ id: string; current: boolean }>;
      }
    ).versions.map((v) => [v.id, v.current]),
    [
      ["ver_new", false],
      ["ver_old", true],
    ],
  );

  // Promoting the current version again is a no-op, not an error.
  const again = await handleAdminApi(
    creator(path, { method: "POST" }),
    st.env,
    path,
  );
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { changed: boolean }).changed, false);
});

test("a draft or foreign version cannot be promoted", async () => {
  const st = state();
  for (const [id, status, code] of [
    ["ver_draft", 409, "version_not_complete"],
    ["ver_other", 404, "version_not_found"],
    ["ver_nope", 404, "version_not_found"],
  ] as const) {
    const path = `/api/v1/artifacts/${KEY}/versions/${id}/promote`;
    const response = await handleAdminApi(
      creator(path, { method: "POST" }),
      st.env,
      path,
    );
    assert.equal(response.status, status, id);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      code,
      id,
    );
  }
  assert.equal(st.artifact.current_version_id, "ver_new");

  const tool = await mcp(st.env, "artifact_manage", {
    action: "promote",
    artifact: KEY,
  });
  assert.equal(tool.isError, true);
  const promoted = await mcp(st.env, "artifact_manage", {
    action: "promote",
    artifact: KEY,
    version_id: "ver_old",
  });
  assert.equal(promoted.isError, undefined);
  assert.equal(promoted.structuredContent.version_id, "ver_old");
  assert.equal(st.artifact.current_version_id, "ver_old");
});

// ---- diff -----------------------------------------------------------------

test("the diff reports every file's status and a unified diff for changed text", async () => {
  const st = state();
  const path = `/api/v1/artifacts/${KEY}/versions/ver_old/diff/ver_new`;
  const response = await handleAdminApi(creator(path), st.env, path);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    from: string;
    to: string;
    from_created_at: number;
    to_created_at: number;
    files: Array<Record<string, unknown>>;
    summary: Record<string, number>;
    truncated: boolean;
  };
  assert.equal(body.from, "ver_old");
  assert.equal(body.to, "ver_new");
  assert.equal(body.from_created_at, 100);
  assert.equal(body.to_created_at, 200);
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.files.map((f) => [f.path, f.status, "diff" in f]),
    [
      ["added.js", "added", false],
      ["app.css", "unchanged", false],
      ["index.html", "changed", true],
      ["logo.png", "changed", false],
      ["removed.txt", "removed", false],
    ],
  );
  assert.deepEqual(body.summary, {
    added: 1,
    removed: 1,
    changed: 2,
    unchanged: 1,
  });
  const html = body.files.find((f) => f.path === "index.html")!;
  assert.equal(html.size_from, OLD_HTML.length);
  assert.equal(html.size_to, NEW_HTML.length);
  assert.match(String(html.sha_from), /^sha-index\.html-/);
  assert.notEqual(html.sha_from, html.sha_to);
  assert.match(
    String(html.diff),
    /^--- a\/index\.html\n\+\+\+ b\/index\.html\n@@ -1 \+1 @@\n-.*old page.*\n\+.*new page.*\n$/,
  );
  const added = body.files.find((f) => f.path === "added.js")!;
  assert.equal(added.size_from, null);
  assert.equal(added.sha_from, null);
  assert.equal(added.size_to, "console.log(1)\n".length);
  // Only the changed text file was read back from storage.
  assert.deepEqual(
    st.bucketReads.map((k) => k.split("/").slice(-3).join("/")).sort(),
    ["ver_new/files/index.html", "ver_old/files/index.html"],
  );

  // `previous` and `current` name the same pair; MCP defaults to them.
  const named = await handleAdminApi(
    creator(`/api/v1/artifacts/${KEY}/versions/previous/diff/current`),
    st.env,
    `/api/v1/artifacts/${KEY}/versions/previous/diff/current`,
  );
  assert.deepEqual(
    ((await named.json()) as { from: string; to: string }).from,
    "ver_old",
  );
  const tool = await mcp(st.env, "artifact_manage", {
    action: "diff",
    artifact: KEY,
  });
  assert.equal(tool.isError, undefined);
  assert.equal(tool.structuredContent.from, "ver_old");
  assert.equal(tool.structuredContent.to, "ver_new");

  const unknown = await handleAdminApi(
    creator(`/api/v1/artifacts/${KEY}/versions/ver_nope/diff/current`),
    st.env,
    `/api/v1/artifacts/${KEY}/versions/ver_nope/diff/current`,
  );
  assert.equal(unknown.status, 404);
  const draft = await handleAdminApi(
    creator(`/api/v1/artifacts/${KEY}/versions/ver_draft/diff/current`),
    st.env,
    `/api/v1/artifacts/${KEY}/versions/ver_draft/diff/current`,
  );
  assert.equal(draft.status, 404);
});

test("diff text is capped per file, per file count and in total", async () => {
  // One file just over the per-file cap: status only.
  const big = "x".repeat(DIFF_MAX_FILE_BYTES + 1) + "\n";
  const many = state({
    versions: [
      versionRow("ver_a", { created_at: 1 }),
      versionRow("ver_b", { created_at: 2 }),
    ],
    current: "ver_b",
    files: [
      fileRow("ver_a", "big.txt", big),
      fileRow("ver_b", "big.txt", big.replace("x", "y")),
      ...Array.from({ length: DIFF_MAX_FILES + 5 }, (_, i) => [
        fileRow("ver_a", `f${String(i).padStart(3, "0")}.txt`, `old ${i}\n`),
        fileRow("ver_b", `f${String(i).padStart(3, "0")}.txt`, `new ${i}\n`),
      ]).flat(),
    ],
  });
  const path = `/api/v1/artifacts/${KEY}/versions/ver_a/diff/ver_b`;
  const response = await handleAdminApi(creator(path), many.env, path);
  const body = (await response.json()) as {
    files: Array<{ path: string; status: string; diff?: string }>;
    truncated: boolean;
  };
  assert.equal(body.truncated, true);
  assert.equal(body.files.find((f) => f.path === "big.txt")?.status, "changed");
  assert.equal(body.files.find((f) => f.path === "big.txt")?.diff, undefined);
  const withDiff = body.files.filter((f) => f.diff);
  assert.equal(withDiff.length, DIFF_MAX_FILES);
  assert.equal(
    body.files.filter((f) => f.status === "changed").length,
    DIFF_MAX_FILES + 6,
  );
  // Big files are never read back; the ones past the cap are not either.
  assert.ok(!many.bucketReads.some((k) => k.endsWith("big.txt")));
  assert.equal(many.bucketReads.length, DIFF_MAX_FILES * 2);

  // Total byte cap: three changed files whose diffs are each ~2/3 of it.
  const lines = (tag: string) =>
    Array.from(
      { length: 1500 },
      (_, i) => `${tag} line ${i} ${"-".repeat(50)}`,
    ).join("\n") + "\n";
  const total = state({
    versions: [
      versionRow("ver_a", { created_at: 1 }),
      versionRow("ver_b", { created_at: 2 }),
    ],
    current: "ver_b",
    files: ["one", "two", "three"].flatMap((name) => [
      fileRow("ver_a", `${name}.md`, lines("old")),
      fileRow("ver_b", `${name}.md`, lines("new")),
    ]),
  });
  const capped = await handleAdminApi(creator(path), total.env, path);
  const cappedBody = (await capped.json()) as {
    files: Array<{ path: string; diff?: string }>;
    truncated: boolean;
  };
  assert.equal(cappedBody.truncated, true);
  const diffs = cappedBody.files.filter((f) => f.diff);
  assert.equal(diffs.length, 1);
  const bytes = diffs.reduce(
    (sum, f) => sum + new TextEncoder().encode(f.diff).byteLength,
    0,
  );
  assert.ok(bytes <= DIFF_MAX_TOTAL_BYTES);
  assert.ok(bytes > DIFF_MAX_TOTAL_BYTES / 2);
});

// ---- base version ---------------------------------------------------------

test("publish/html with a stale base_version_id is refused before anything is written", async () => {
  const st = state();
  const response = await handlePublish(
    creator("/api/v1/publish/html", {
      method: "POST",
      body: JSON.stringify({
        artifact: KEY,
        html: "<h1>clobber</h1>",
        base_version_id: "ver_old",
      }),
    }),
    st.env,
    "/api/v1/publish/html",
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, "version_conflict");
  assert.equal(body.error.current_version_id, "ver_new");
  assert.equal(body.error.current_created_at, 200);
  assert.equal(body.error.base_version_id, "ver_old");
  assert.equal(body.error.current_url, `${ORIGIN}${PATH}_v/ver_new/`);
  assert.match(
    String(body.error.message),
    /republish with base_version_id set to ver_new/,
  );
  assert.equal(st.writes.length, 0);
  assert.equal(st.bucketWrites.length, 0);
  assert.equal(st.artifact.current_version_id, "ver_new");

  // The slug spelling resolves to the same artifact.
  const bySlug = await handlePublish(
    creator("/api/v1/publish/html", {
      method: "POST",
      body: JSON.stringify({
        artifact: "ver-demo",
        html: "<h1>clobber</h1>",
        base_version_id: "ver_old",
      }),
    }),
    st.env,
    "/api/v1/publish/html",
  );
  assert.equal(bySlug.status, 409);

  // Over MCP the conflict is a tool error carrying the same detail.
  const tool = await mcp(st.env, "artifact_publish", {
    artifact: KEY,
    html: "<h1>clobber</h1>",
    base_version_id: "ver_old",
  });
  assert.equal(tool.isError, true);
  const err = tool.structuredContent.error as {
    code: string;
    status: number;
    detail: { error: { current_version_id: string } };
  };
  assert.equal(err.code, "version_conflict");
  assert.equal(err.status, 409);
  assert.equal(err.detail.error.current_version_id, "ver_new");
});

test("publish/start and upload-session honour base_version_id the same way", async () => {
  const st = state();
  for (const route of ["start", "upload-session"]) {
    const stale = await handlePublish(
      creator(`/api/v1/publish/${route}`, {
        method: "POST",
        body: JSON.stringify({ artifact: KEY, base_version_id: "ver_old" }),
      }),
      st.env,
      `/api/v1/publish/${route}`,
    );
    assert.equal(stale.status, 409, route);
    assert.equal(
      ((await stale.json()) as { error: { code: string } }).error.code,
      "version_conflict",
      route,
    );
    assert.equal(st.writes.length, 0, route);
  }
  const fresh = await handlePublish(
    creator("/api/v1/publish/start", {
      method: "POST",
      body: JSON.stringify({ artifact: KEY, base_version_id: "ver_new" }),
    }),
    st.env,
    "/api/v1/publish/start",
  );
  assert.equal(fresh.status, 200);
  const started = (await fresh.json()) as { version: { id: string } };
  assert.ok(st.versions.get(started.version.id));
  assert.equal(st.versions.get(started.version.id)?.status, "draft");

  const session = await mcp(st.env, "artifact_upload_session", {
    artifact: KEY,
    base_version_id: "ver_old",
  });
  assert.equal(session.isError, true);
  assert.equal(
    (session.structuredContent.error as { code: string }).code,
    "version_conflict",
  );
});

test("a matching base_version_id publishes, and every publish result carries links", async () => {
  const st = state();
  const response = await handlePublish(
    creator("/api/v1/publish/html", {
      method: "POST",
      body: JSON.stringify({
        artifact: KEY,
        html: "<h1>third</h1>",
        base_version_id: "ver_new",
      }),
    }),
    st.env,
    "/api/v1/publish/html",
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    version_id: string;
    url: string;
    links: Record<string, string>;
  };
  assert.match(body.version_id, /^ver_[a-f0-9]{32}$/);
  assert.equal(st.artifact.current_version_id, body.version_id);
  assert.deepEqual(body.links, {
    artifact: `${ORIGIN}/go/${KEY}/`,
    version: `${ORIGIN}/go/${KEY}/_v/${body.version_id}/`,
    review: `${ORIGIN}/go/${KEY}/`,
  });
  // The HTML publish records a content hash so later diffs compare by sha.
  const stored = st.files
    .get(body.version_id)
    ?.find((f) => f.path === "index.html");
  assert.match(String(stored?.sha256), /^[a-f0-9]{64}$/);

  // The new version is now the base; the old id is stale.
  const stale = await handlePublish(
    creator("/api/v1/publish/html", {
      method: "POST",
      body: JSON.stringify({
        artifact: KEY,
        html: "<h1>fourth</h1>",
        base_version_id: "ver_new",
      }),
    }),
    st.env,
    "/api/v1/publish/html",
  );
  assert.equal(stale.status, 409);

  // Upload completion carries links too.
  const started = (await (
    await handlePublish(
      creator("/api/v1/publish/start", {
        method: "POST",
        body: JSON.stringify({
          artifact: KEY,
          base_version_id: body.version_id,
        }),
      }),
      st.env,
      "/api/v1/publish/start",
    )
  ).json()) as { version: { id: string } };
  const draftId = started.version.id;
  const bytes = new TextEncoder().encode("<h1>uploaded</h1>");
  const put = await handlePublish(
    creator(`/api/v1/publish/${draftId}/files/index.html`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "X-Artifact-Sha256": "a".repeat(64),
      },
      body: bytes,
    }),
    st.env,
    `/api/v1/publish/${draftId}/files/index.html`,
  );
  assert.equal(put.status, 200);
  const completed = await handlePublish(
    creator(`/api/v1/publish/${draftId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        entrypoint: "index.html",
        files: [{ path: "index.html", size: bytes.byteLength }],
      }),
    }),
    st.env,
    `/api/v1/publish/${draftId}/complete`,
  );
  assert.equal(completed.status, 200);
  const done = (await completed.json()) as {
    version_id: string;
    links: Record<string, string>;
  };
  assert.equal(done.version_id, draftId);
  assert.equal(done.links.version, `${ORIGIN}/go/${KEY}/_v/${draftId}/`);
  assert.equal(done.links.artifact, `${ORIGIN}/go/${KEY}/`);
  assert.equal(done.links.review, `${ORIGIN}/go/${KEY}/`);

  // And the MCP publish tool.
  const tool = await mcp(st.env, "artifact_publish", {
    artifact: KEY,
    html: "<h1>fifth</h1>",
    base_version_id: draftId,
  });
  assert.equal(tool.isError, undefined);
  const links = tool.structuredContent.links as Record<string, string>;
  assert.equal(links.artifact, `${ORIGIN}/go/${KEY}/`);
  assert.equal(
    links.version,
    `${ORIGIN}/go/${KEY}/_v/${tool.structuredContent.version_id}/`,
  );
});

test("base_version_id on an artifact that does not exist yet is a conflict too", async () => {
  const st = state();
  const response = await handlePublish(
    creator("/api/v1/publish/html", {
      method: "POST",
      body: JSON.stringify({
        artifact: "brand-new",
        html: "<h1>new</h1>",
        base_version_id: "ver_old",
      }),
    }),
    st.env,
    "/api/v1/publish/html",
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, "version_conflict");
  assert.equal(body.error.current_version_id, null);
  assert.equal(st.writes.length, 0);
});
