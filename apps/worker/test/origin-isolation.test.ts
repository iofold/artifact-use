import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { fixture, bearer } from "./security-review/fixture.ts";
import { viewerCookieName } from "../src/auth.ts";

test("legacy browser links redirect to the artifact's own origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_public", "org_other", "public");
  const r = await f.request(`/go/${a.url_key}/?tab=2`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(r.status, 302);
  assert.equal(
    r.headers.get("Location"),
    `https://a-public.pages.example/go/${a.url_key}/?tab=2`,
  );
});

test("artifact hosts cannot use publisher cookies, admin routes, or other artifact endpoints", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_attacker", "org_other", "public");
  const b = f.artifact("art_victim");
  const cookie = `au_pub=${encodeURIComponent(await f.publisher())}; ${viewerCookieName(b.id)}=${encodeURIComponent(await f.viewer(b))}`;
  for (const path of [
    "/admin",
    "/api/v1/artifacts",
    `/go/${b.url_key}/private.txt`,
    `/_au/comments?artifact_key=${b.url_key}`,
    `/_au/versions?artifact_key=${b.url_key}`,
  ]) {
    const r = await worker.fetch(
      new Request(`https://a-attacker.pages.example${path}`, {
        headers: { Cookie: cookie, Accept: "text/html" },
      }),
      f.env,
    );
    assert.equal(r.status, 404, path);
  }
  const post = await worker.fetch(
    new Request("https://a-attacker.pages.example/_au/agent-token", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ artifact_key: b.url_key }),
    }),
    f.env,
  );
  assert.equal(post.status, 404);
  const own = await worker.fetch(
    new Request(`https://a-attacker.pages.example/go/${a.url_key}/`),
    f.env,
  );
  assert.equal(own.status, 200);
  assert.equal(
    own.headers.get("Content-Security-Policy"),
    null,
    "interactive HTML runs on its isolated origin",
  );
});

test("trusted-origin artifact bytes remain available to agents but cannot execute as a trusted document", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_agent");
  const r = await f.request(`/go/${a.url_key}/`, {
    headers: bearer(await f.creator()),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Security-Policy") || "", /sandbox/);
  assert.doesNotMatch(
    r.headers.get("Content-Security-Policy") || "",
    /allow-same-origin|allow-scripts/,
  );
  assert.match(await r.text(), /PRIVATE_ARTIFACT_BYTES/);
});

test("missing isolation configuration does not execute uploaded HTML on the trusted origin", async () => {
  const f = fixture();
  const a = f.artifact("art_fallback", "org_other", "public");
  const r = await f.request(`/go/${a.url_key}/`, {
    headers: { Accept: "text/html" },
  });
  assert.match(r.headers.get("Content-Security-Policy") || "", /sandbox/);
  assert.doesNotMatch(
    r.headers.get("Content-Security-Policy") || "",
    /allow-scripts|allow-same-origin/,
  );
});

test("a signed-in publisher crosses to the target origin with a one-use artifact-scoped handoff", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  const a = f.artifact("art_member");
  const cookie = `au_pub=${encodeURIComponent(await f.publisher())}; ${viewerCookieName(a.id)}=${encodeURIComponent(await f.viewer(a))}`;
  const start = await f.request(`/go/${a.url_key}/`, {
    headers: { Accept: "text/html", Cookie: cookie },
  });
  assert.equal(start.status, 302);
  const destination = start.headers.get("Location") || "";
  assert.equal(new URL(destination).origin, "https://a-member.pages.example");
  assert.ok(new URL(destination).searchParams.get("__au_handoff"));
  const landed = await worker.fetch(
    new Request(destination, { headers: { Accept: "text/html" } }),
    f.env,
  );
  assert.equal(landed.status, 303);
  const viewerCookie = landed.headers
    .getSetCookie()
    .find((x) => x.startsWith(viewerCookieName(a.id) + "="));
  assert.ok(viewerCookie);
  assert.doesNotMatch(viewerCookie, /Domain=/i);
  assert.equal(
    (await worker.fetch(new Request(destination), f.env)).status,
    401,
    "handoff cannot be replayed",
  );
  const page = await worker.fetch(
    new Request(new URL(landed.headers.get("Location")!, destination), {
      headers: { Accept: "text/html", Cookie: viewerCookie.split(";")[0] },
    }),
    f.env,
  );
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PRIVATE_ARTIFACT_BYTES/);
  const context = await worker.fetch(
    new Request(
      `https://a-member.pages.example/_au/artifact-context?artifact_key=${a.url_key}`,
      { headers: { Cookie: viewerCookie.split(";")[0] } },
    ),
    f.env,
  );
  const info = (await context.json()) as { role: string; admin_url: string };
  assert.equal(info.role, "publisher");
  assert.equal(new URL(info.admin_url).origin, "https://audit.example");
});

test("unknown hosts cannot reach the application", async () => {
  const f = fixture();
  const r = await worker.fetch(
    new Request("https://unconfigured.example/health"),
    f.env,
  );
  assert.equal(r.status, 404);
});
