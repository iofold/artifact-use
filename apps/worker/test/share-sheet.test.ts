// The share sheet: one read and one write for the publisher's admin session,
// reached from the artifact through a link and never through the artifact's
// own origin.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { issueAdminCsrfToken, viewerCookieName } from "../src/auth.ts";
import worker from "../src/index.ts";
import { isAllowed } from "../src/gate.ts";
import { injectWidget } from "../src/serve.ts";
import {
  normalizeAllowlistPolicy,
  parseAllowlistEntries,
  readAllowlist,
} from "../src/share.ts";
import type { Artifact } from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import { bearer, fixture } from "./security-review/fixture.ts";

type Fixture = ReturnType<typeof fixture>;
type State = {
  artifact: {
    id: string;
    url: string;
    gate_level: string;
    has_upstream: boolean;
    allowlist: { emails: string[]; domains: string[] };
  };
  links: Array<{ id: string; state: string; url: string }>;
};

async function admin(f: Fixture, csrfHeader = true) {
  const raw = await f.publisher();
  const csrf = await issueAdminCsrfToken(raw, nowSec() + 3600, f.env);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Cookie: `__Host-au_pub=${encodeURIComponent(raw)}; __Host-au_admin_csrf=${encodeURIComponent(csrf.token)}`,
  };
  if (csrfHeader) headers["X-CSRF-Token"] = csrf.token;
  return {
    headers,
    get: (path: string) => f.request(path, { headers }),
    post: (path: string, body: unknown) =>
      f.request(path, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

function stored(f: Fixture, a: Artifact): Artifact {
  return f.raw
    .prepare("SELECT * FROM artifacts WHERE id = ?")
    .get(a.id) as unknown as Artifact;
}

function seedLink(f: Fixture, a: Artifact, id: string) {
  f.raw
    .prepare(
      `INSERT INTO share_links (id, artifact_id, kind, created_by, created_at)
       VALUES (?, ?, 'open', 'user_AUDIT', 1)`,
    )
    .run(id, a.id);
}

test("the sheet reads the link, the gate, the allowlist and the direct links", async () => {
  const f = fixture();
  const a = f.artifact("art_sheet");
  seedLink(f, a, "shr_sheet");
  const me = await admin(f);
  const response = await me.get(`/admin/api/artifact/share?id=${a.id}`);
  assert.equal(response.status, 200);
  const state = (await response.json()) as State;
  assert.equal(state.artifact.url, `https://audit.example/go/${a.url_key}/`);
  assert.equal(state.artifact.gate_level, "allowlist");
  assert.equal(state.artifact.has_upstream, false);
  assert.deepEqual(state.artifact.allowlist, {
    emails: ["victim@example.com"],
    domains: [],
  });
  assert.deepEqual(
    state.links.map((link) => [link.id, link.state, link.url]),
    [
      [
        "shr_sheet",
        "active",
        `https://audit.example/go/${a.url_key}/?v=shr_sheet`,
      ],
    ],
  );
});

test("the sheet's routes need the admin session and its CSRF token", async () => {
  const f = fixture();
  const a = f.artifact("art_sheetauth");
  const anonymous = await f.request(`/admin/api/artifact/share?id=${a.id}`);
  assert.equal(anonymous.status, 401);
  const noCsrf = await admin(f, false);
  const blocked = await noCsrf.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    gate_level: "public",
  });
  assert.equal(blocked.status, 403);
  assert.equal(stored(f, a).gate_level, "allowlist");
  // A workspace token is not an admin session: the sheet's API has no bearer
  // path, so nothing an agent or an artifact page holds can call it.
  const token = await f.request(`/admin/api/artifact/share?id=${a.id}`, {
    headers: bearer(await f.creator()),
  });
  assert.equal(token.status, 401);
});

test("another workspace's artifact is not found, and one of yours names the workspace to switch to", async () => {
  const f = fixture();
  const foreign = f.artifact("art_foreign", "org_stranger");
  const mine = f.artifact("art_elsewhere", "org_01SECOND");
  f.raw
    .prepare(
      "INSERT INTO workspace_memberships (user_id, org_id, org_name, org_slug, role, checked_at) VALUES ('user_AUDIT', 'org_01SECOND', 'Second Studio', 'second-studio', 'member', ?)",
    )
    .run(nowSec());
  f.raw
    .prepare(
      "INSERT INTO workspace_membership_sync (user_id, refreshed_at) VALUES ('user_AUDIT', ?)",
    )
    .run(nowSec());
  const me = await admin(f);

  const stranger = await me.get(`/admin/api/artifact/share?id=${foreign.id}`);
  assert.equal(stranger.status, 404);
  const missing = await me.get("/admin/api/artifact/share?id=art_nope");
  assert.equal(missing.status, 404);
  assert.deepEqual(await stranger.json(), await missing.json());

  const other = await me.get(`/admin/api/artifact/share?id=${mine.id}`);
  assert.equal(other.status, 409);
  const body = (await other.json()) as {
    error: { code: string };
    workspace: { name: string; switch_url: string };
    artifact?: unknown;
  };
  assert.equal(body.error.code, "other_workspace");
  assert.equal(body.workspace.name, "Second Studio");
  assert.equal(
    body.workspace.switch_url,
    `/admin/switch?org=org_01SECOND&next=${encodeURIComponent(`/admin/share?artifact=${mine.id}`)}`,
  );
  assert.equal(body.artifact, undefined);

  // Writes stay scoped to the signed-in workspace either way.
  for (const a of [foreign, mine]) {
    const write = await me.post("/admin/api/artifact/access", {
      artifact_key: a.url_key,
      gate_level: "public",
    });
    assert.equal(write.status, 404);
    assert.equal(stored(f, a).gate_level, "allowlist");
  }
});

test("switching workspaces can return to the share sheet, and nowhere off the admin", async () => {
  const f = fixture();
  f.raw
    .prepare(
      "INSERT INTO workspace_memberships (user_id, org_id, org_name, org_slug, role, checked_at) VALUES ('user_AUDIT', 'org_01SECOND', 'Second Studio', 'second-studio', 'member', ?)",
    )
    .run(nowSec());
  f.raw
    .prepare(
      "INSERT INTO workspace_membership_sync (user_id, refreshed_at) VALUES ('user_AUDIT', ?)",
    )
    .run(nowSec());
  const raw = await f.publisher();
  const go = (next: string) =>
    f.request(
      `/admin/switch?org=org_01SECOND&next=${encodeURIComponent(next)}`,
      {
        redirect: "manual",
        headers: {
          Accept: "text/html",
          "Sec-Fetch-Site": "same-origin",
          Cookie: `__Host-au_pub=${encodeURIComponent(raw)}`,
        },
      },
    );
  const back = await go("/admin/share?artifact=art_x");
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("Location"), "/admin/share?artifact=art_x");
  for (const next of [
    "https://evil.example/admin/share",
    "//evil.example/admin/",
    "/go/some-artifact/",
    "/admin/../go/x",
    "/admin/share?artifact=art_x&open=/go/x",
    "/admin/super",
  ]) {
    const response = await go(next);
    assert.equal(response.headers.get("Location"), "/admin", next);
  }
});

test("changing who can open the link takes effect at the gate", async () => {
  const f = fixture();
  const a = f.artifact("art_levels");
  const me = await admin(f);
  for (const level of ["verified_email", "email", "public", "allowlist"]) {
    const response = await me.post("/admin/api/artifact/access", {
      artifact_key: a.url_key,
      gate_level: level,
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as State;
    assert.equal(state.artifact.gate_level, level);
    assert.equal(stored(f, a).gate_level, level);
  }
  const bad = await me.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    gate_level: "everyone",
  });
  assert.equal(bad.status, 400);
  assert.equal(stored(f, a).gate_level, "allowlist");
  // The list set before the round trip is still the list.
  assert.equal(isAllowed(stored(f, a), "victim@example.com"), true);
});

test("people and domains are added and removed one change at a time", async () => {
  const f = fixture();
  const a = f.artifact("art_people");
  const me = await admin(f);
  const added = await me.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    add: "Jane@Acme.com, @partner.io\nteam.example.org; jane@acme.com",
  });
  assert.equal(added.status, 200);
  assert.deepEqual(((await added.json()) as State).artifact.allowlist, {
    emails: ["victim@example.com", "jane@acme.com"],
    domains: ["partner.io", "team.example.org"],
  });
  const row = stored(f, a);
  assert.equal(isAllowed(row, "jane@acme.com"), true);
  assert.equal(isAllowed(row, "anyone@partner.io"), true);
  assert.equal(isAllowed(row, "anyone@elsewhere.io"), false);

  const removed = await me.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    remove: ["victim@example.com", "partner.io"],
  });
  assert.deepEqual(((await removed.json()) as State).artifact.allowlist, {
    emails: ["jane@acme.com"],
    domains: ["team.example.org"],
  });
  assert.equal(isAllowed(stored(f, a), "victim@example.com"), false);
  assert.equal(isAllowed(stored(f, a), "anyone@partner.io"), false);
});

test("an entry that is not an address or a domain is refused, and nobody is locked out", async () => {
  const f = fixture();
  const a = f.artifact("art_typo");
  const me = await admin(f);
  const before = stored(f, a).allowlist_json;
  const response = await me.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    add: "dana@acme.com, jane@, Acme Corp",
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(body.error.code, "invalid_allowlist_entry");
  assert.match(body.error.message, /jane@/);
  assert.equal(stored(f, a).allowlist_json, before);
  assert.equal(isAllowed(stored(f, a), "victim@example.com"), true);

  // The older textarea save: one typo used to be stored, and a stored typo
  // makes the gate refuse every address on the list.
  const form = await f.request("/admin/artifact/access", {
    method: "POST",
    headers: { ...me.headers },
    body: new URLSearchParams({
      artifact_key: a.url_key,
      gate_level: "allowlist",
      allowlist_lines: "victim@example.com\nnot a domain",
    }),
  });
  assert.equal(form.status, 400);
  assert.equal(stored(f, a).allowlist_json, before);
  assert.equal(isAllowed(stored(f, a), "victim@example.com"), true);
});

test("the REST allowlist is validated and normalized before it is stored", async () => {
  const f = fixture();
  const a = f.artifact("art_restlist");
  const token = await f.creator();
  const patch = (allowlist: unknown) =>
    f.request(`/api/v1/artifacts/${a.url_key}`, {
      method: "PATCH",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ allowlist }),
    });
  for (const bad of [
    { emails: ["ok@acme.com", "nope"] },
    { domains: ["acme"] },
    ["ok@acme.com"],
    { emails: "ok@acme.com" },
  ]) {
    const response = await patch(bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "invalid_allowlist",
    );
    assert.equal(isAllowed(stored(f, a), "victim@example.com"), true);
  }
  const good = await patch({
    emails: ["Dana@Acme.com"],
    domains: ["@Corp.io"],
  });
  assert.equal(good.status, 200);
  assert.deepEqual(readAllowlist(stored(f, a).allowlist_json), {
    emails: ["dana@acme.com"],
    domains: ["corp.io"],
  });
  assert.equal(isAllowed(stored(f, a), "someone@corp.io"), true);
});

test("an artifact with a backend cannot be opened to anyone with the link", async () => {
  const f = fixture();
  const a = f.artifact("art_backend");
  f.raw
    .prepare(
      "INSERT INTO artifact_upstreams (artifact_id, base_url, created_at, updated_at) VALUES (?, 'https://api.example.com', 1, 1)",
    )
    .run(a.id);
  const me = await admin(f);
  const state = (await (
    await me.get(`/admin/api/artifact/share?id=${a.id}`)
  ).json()) as State;
  assert.equal(state.artifact.has_upstream, true);
  const json = await me.post("/admin/api/artifact/access", {
    artifact_key: a.url_key,
    gate_level: "public",
  });
  assert.equal(json.status, 409);
  const form = await f.request("/admin/artifact/access", {
    method: "POST",
    headers: { ...me.headers },
    body: new URLSearchParams({
      artifact_key: a.url_key,
      gate_level: "public",
    }),
  });
  assert.equal(form.status, 409);
  assert.equal(stored(f, a).gate_level, "allowlist");
});

test("revoking from the sheet closes that link, and only on your own artifact", async () => {
  const f = fixture();
  const a = f.artifact("art_revoke");
  const b = f.artifact("art_revokeother", "org_stranger");
  seedLink(f, a, "shr_mine");
  seedLink(f, b, "shr_theirs");
  const me = await admin(f);
  const crossed = await me.post("/admin/api/artifact/share-link/revoke", {
    artifact_key: a.url_key,
    id: "shr_theirs",
  });
  assert.equal(crossed.status, 404);
  const foreign = await me.post("/admin/api/artifact/share-link/revoke", {
    artifact_key: b.url_key,
    id: "shr_theirs",
  });
  assert.equal(foreign.status, 404);
  const revokedAt = (id: string) =>
    (
      f.raw
        .prepare("SELECT revoked_at FROM share_links WHERE id = ?")
        .get(id) as { revoked_at: number | null }
    ).revoked_at;
  assert.equal(revokedAt("shr_theirs"), null);

  const response = await me.post("/admin/api/artifact/share-link/revoke", {
    artifact_key: a.url_key,
    id: "shr_mine",
  });
  assert.equal(response.status, 200);
  const state = (await response.json()) as State;
  assert.deepEqual(
    state.links.map((link) => [link.id, link.state]),
    [["shr_mine", "revoked"]],
  );
  assert.ok(revokedAt("shr_mine"));
});

test("the share page and the agents page are served by the admin shell", async () => {
  const f = fixture();
  const raw = await f.publisher();
  for (const path of ["/admin/share?artifact=art_x", "/admin/agents"]) {
    const response = await f.request(path, {
      headers: {
        Accept: "text/html",
        Cookie: `__Host-au_pub=${encodeURIComponent(raw)}`,
      },
    });
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /Synthetic admin shell/);
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(
      response.headers.get("Cross-Origin-Opener-Policy"),
      "same-origin",
    );
  }
  // Signed out, the share link comes back to the sheet after sign-in.
  const signedOut = await f.request("/admin/share?artifact=art_x", {
    redirect: "manual",
    headers: { Accept: "text/html" },
  });
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get("Location"), "/login");
  assert.match(
    signedOut.headers.getSetCookie().join("\n"),
    /__Host-au_next=%2Fadmin%2Fshare%3Fartifact%3Dart_x/,
  );
});

test("nothing about sharing is reachable on an artifact's own origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_isolated");
  const me = await admin(f);
  for (const [method, path] of [
    ["GET", `/admin/share?artifact=${a.id}`],
    ["GET", `/admin/api/artifact/share?id=${a.id}`],
    ["POST", "/admin/api/artifact/access"],
    ["POST", "/admin/api/artifact/share-link"],
    ["POST", "/admin/api/artifact/share-link/revoke"],
  ] as const) {
    const response = await worker.fetch(
      new Request(`https://a-isolated.pages.example${path}`, {
        method,
        headers: {
          ...me.headers,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                artifact_key: a.url_key,
                gate_level: "public",
                kind: "open",
              }),
            }
          : {}),
      }),
      f.env,
    );
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(stored(f, a).gate_level, "allowlist");
  assert.equal(
    (
      f.raw
        .prepare("SELECT COUNT(*) AS n FROM share_links WHERE artifact_id = ?")
        .get(a.id) as { n: number }
    ).n,
    0,
  );
});

test("a workspace member's page load carries the sheet's address; a viewer's never does", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_launcher");
  const page = async (
    session: Parameters<Fixture["viewer"]>[1],
    fetchHeaders: Record<string, string>,
  ) => {
    const response = await worker.fetch(
      new Request(`https://a-launcher.pages.example/go/${a.url_key}/`, {
        headers: {
          Accept: "text/html",
          Cookie: `${viewerCookieName(a.id)}=${encodeURIComponent(await f.viewer(a, session))}`,
          ...fetchHeaders,
        },
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    // The page's widget config, not the widget's own source.
    const config = /window\.__AU_FEEDBACK__=(\{.*?\});<\/script>/.exec(
      await response.text(),
    );
    assert.ok(config, "the widget is injected");
    return JSON.parse(config[1]!) as { shareUrl?: string };
  };
  const navigation = {
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  const member = await page({ workspace_user_id: "user_AUDIT" }, navigation);
  assert.equal(
    member.shareUrl,
    `https://audit.example/admin/share?artifact=${a.id}`,
  );
  const viewer = await page({}, navigation);
  assert.equal("shareUrl" in viewer, false);
  // Only a top-level page load: a script reading the page gets the viewer's.
  const fetched = await page(
    { workspace_user_id: "user_AUDIT" },
    { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
  );
  assert.equal("shareUrl" in fetched, false);
});

test("the widget is handed the sheet's address only when one is passed", () => {
  const artifact = { url_key: "cfg-abc123", gate_level: "email" } as Artifact;
  const env = {
    SITE_BASE_URL: "https://audit.example",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
  } as never;
  const config = (html: string) =>
    JSON.parse(/window\.__AU_FEEDBACK__=(\{.*?\});<\/script>/.exec(html)![1]!);
  const viewer = config(injectWidget("<body></body>", artifact, "ver_1", env));
  assert.equal("shareUrl" in viewer, false);
  const member = config(
    injectWidget(
      "<body></body>",
      artifact,
      "ver_1",
      env,
      "https://audit.example/admin/share?artifact=art_cfg",
    ),
  );
  assert.equal(
    member.shareUrl,
    "https://audit.example/admin/share?artifact=art_cfg",
  );
});

test("allowlist entries parse the way people type them", () => {
  assert.deepEqual(parseAllowlistEntries("a@b.co  c.io,\n*.d.org ; @e.dev"), {
    ok: true,
    list: { emails: ["a@b.co"], domains: ["c.io", "d.org", "e.dev"] },
  });
  assert.deepEqual(parseAllowlistEntries(["x@y.zz", "x@y.zz"]), {
    ok: true,
    list: { emails: ["x@y.zz"], domains: [] },
  });
  assert.deepEqual(parseAllowlistEntries("localhost a@b"), {
    ok: false,
    invalid: ["localhost", "a@b"],
  });
  assert.deepEqual(parseAllowlistEntries(""), {
    ok: true,
    list: { emails: [], domains: [] },
  });
  // A stored policy that is already broken reads as empty, not as a crash.
  assert.deepEqual(readAllowlist("not json"), { emails: [], domains: [] });
  assert.deepEqual(readAllowlist('{"emails":"x"}'), {
    emails: [],
    domains: [],
  });
  assert.equal(normalizeAllowlistPolicy("a@b.co").ok, false);
});

test("the widget's Share control is a link to the sheet and nothing more", async () => {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");
  // Rendered only when the server named a sheet for this viewer.
  assert.match(source, /if \(!shareUrl \|\| shareBtn\) return;/);
  // Opened with no handle back to the artifact's page.
  assert.match(source, /"popup,noopener,noreferrer,width="/);
  assert.match(source, /a\.rel = "noopener noreferrer";/);
  // The artifact's realm never calls the sharing API or holds a share link.
  assert.doesNotMatch(source, /admin\/api/);
  assert.doesNotMatch(source, /share-link/);
});
