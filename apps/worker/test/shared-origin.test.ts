// ARTIFACT_SHARED_ORIGIN: a deployment that says so by name keeps artifact
// pages running on SITE_BASE_URL, at their existing links, instead of moving
// them to per-artifact hosts. Nothing short of that exact setting does it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { viewerCookieName } from "../src/auth.ts";
import { sharedOriginArtifacts } from "../src/origins.ts";
import type { Env } from "../src/types.ts";
import { bearer, fixture } from "./security-review/fixture.ts";

const navigation = {
  Accept: "text/html",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

function widgetConfig(html: string): { shareUrl?: string } {
  const config = /window\.__AU_FEEDBACK__=(\{.*?\});<\/script>/.exec(html);
  assert.ok(config, "the widget is injected");
  return JSON.parse(config[1]!) as { shareUrl?: string };
}

test("asked for by name, an artifact runs at its existing link on the site origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_SHARED_ORIGIN = "true";
  const a = f.artifact("art_shared", "org_other", "public");
  const page = await f.request(`/go/${a.url_key}/`, { headers: navigation });
  assert.equal(page.status, 200, "served in place, not redirected");
  assert.equal(page.headers.get("Content-Security-Policy"), null);
  const html = await page.text();
  assert.match(html, /PRIVATE_ARTIFACT_BYTES/);
  widgetConfig(html);
  const file = await f.request(`/go/${a.url_key}/private.txt`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("Content-Security-Policy"), null);
});

test("only the exact setting turns the sandbox off", async () => {
  for (const value of [undefined, "", "false", "1", "yes", "on"]) {
    const f = fixture();
    if (value !== undefined) f.env.ARTIFACT_SHARED_ORIGIN = value;
    const a = f.artifact("art_inert", "org_other", "public");
    const page = await f.request(`/go/${a.url_key}/`, { headers: navigation });
    const csp = page.headers.get("Content-Security-Policy") || "";
    assert.match(csp, /sandbox/, `value ${JSON.stringify(value)}`);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  }
  assert.equal(
    sharedOriginArtifacts({ ARTIFACT_SHARED_ORIGIN: " TRUE " } as Env),
    true,
  );
});

test("the host suffix wins when both are set", async () => {
  const f = fixture();
  f.env.ARTIFACT_SHARED_ORIGIN = "true";
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  assert.equal(sharedOriginArtifacts(f.env), false);
  const a = f.artifact("art_both", "org_other", "public");
  const page = await f.request(`/go/${a.url_key}/`, {
    redirect: "manual",
    headers: navigation,
  });
  assert.equal(page.status, 302);
  assert.equal(
    new URL(page.headers.get("Location") || "").host,
    "a-both.pages.example",
  );
  const bytes = await f.request(`/go/${a.url_key}/`, {
    headers: bearer(await f.creator("org_other")),
  });
  assert.match(bytes.headers.get("Content-Security-Policy") || "", /sandbox/);
});

test("a workspace member gets Share on the shared origin; a viewer and another workspace do not", async () => {
  const f = fixture();
  f.env.ARTIFACT_SHARED_ORIGIN = "true";
  const mine = f.artifact("art_mine");
  const theirs = f.artifact("art_theirs", "org_other", "public");
  const publisher = `__Host-au_pub=${encodeURIComponent(await f.publisher())}`;
  // As a browser does: keep the cookies a redirect sets and follow it (a
  // member's first visit bounces once to pick up a viewer session).
  const config = async (key: string, cookie: string) => {
    let path = `/go/${key}/`;
    for (let hop = 0; hop < 4; hop++) {
      const page = await f.request(path, {
        redirect: "manual",
        headers: { ...navigation, Cookie: cookie },
      });
      if (page.status === 200) return widgetConfig(await page.text());
      assert.equal(page.status, 302);
      const next = new URL(page.headers.get("Location")!, f.env.SITE_BASE_URL);
      assert.equal(next.origin, f.env.SITE_BASE_URL, "never leaves the site");
      path = next.pathname + next.search;
      for (const set of page.headers.getSetCookie())
        cookie += `; ${set.split(";")[0]}`;
    }
    throw new Error("redirect loop");
  };
  const sheet = `${f.env.SITE_BASE_URL}/admin/share?artifact=${mine.id}`;
  assert.equal(
    new URL(
      (await config(mine.url_key, publisher)).shareUrl || "/none",
      f.env.SITE_BASE_URL,
    ).href,
    sheet,
  );
  const viewer = `${viewerCookieName(mine.id)}=${encodeURIComponent(await f.viewer(mine))}`;
  assert.equal("shareUrl" in (await config(mine.url_key, viewer)), false);
  assert.equal(
    "shareUrl" in (await config(theirs.url_key, publisher)),
    false,
    "an artifact from another workspace",
  );
  const context = await f.request(
    `/_au/artifact-context?artifact_key=${mine.url_key}`,
    { headers: { Cookie: publisher, Accept: "application/json" } },
  );
  assert.equal(
    new URL(
      ((await context.json()) as { share_url?: string }).share_url || "/none",
      f.env.SITE_BASE_URL,
    ).href,
    sheet,
  );
});

test("failed discovery stays bounded on the shared origin", async () => {
  const f = fixture();
  f.env.ARTIFACT_SHARED_ORIGIN = "true";
  const guess = (path: string, ip: string) =>
    f.request(path, { headers: { "CF-Connecting-IP": ip } });
  for (let i = 0; i < 60; i++)
    assert.equal((await guess(`/go/missing-${i}/`, "192.0.2.90")).status, 404);
  const a = f.artifact("art_bounded", "org_other", "public");
  const file = `/go/${a.url_key}/private.txt`;
  assert.equal((await guess(file, "192.0.2.90")).status, 429);
  assert.equal((await guess(file, "192.0.2.91")).status, 200);
});

test("the deploy check takes isolation or the named setting, never neither or both", async () => {
  const script = fileURLToPath(
    new URL("../scripts/check-artifact-origin.mjs", import.meta.url),
  );
  const dir = await mkdtemp(join(tmpdir(), "au-origin-check-"));
  const check = async (name: string, toml: string) => {
    const file = join(dir, name);
    await writeFile(file, toml);
    try {
      const done = await promisify(execFile)(process.execPath, [script, file]);
      return { ok: true, text: done.stdout + done.stderr };
    } catch (failure) {
      const { stdout, stderr } = failure as { stdout: string; stderr: string };
      return { ok: false, text: stdout + stderr };
    }
  };
  const isolated = await check(
    "isolated.toml",
    'pattern = "*.pages.example.com/*"\n[vars]\nARTIFACT_HOST_SUFFIX = "pages.example.com"\n',
  );
  assert.equal(isolated.ok, true);
  const shared = await check(
    "shared.toml",
    '[vars]\nARTIFACT_SHARED_ORIGIN = "true"\n',
  );
  assert.equal(shared.ok, true);
  assert.match(shared.text, /SHARED/);
  assert.match(shared.text, /can act as the signed-in person/);
  const neither = await check("neither.toml", "[vars]\n");
  assert.equal(neither.ok, false);
  const commented = await check(
    "commented.toml",
    '[vars]\n# ARTIFACT_SHARED_ORIGIN = "true"\nARTIFACT_SHARED_ORIGIN = "false"\n',
  );
  assert.equal(commented.ok, false);
  const both = await check(
    "both.toml",
    'pattern = "*.pages.example.com/*"\n[vars]\nARTIFACT_HOST_SUFFIX = "pages.example.com"\nARTIFACT_SHARED_ORIGIN = "true"\n',
  );
  assert.equal(both.ok, false);
  assert.match(both.text, /both set/);
  const noRoute = await check(
    "no-route.toml",
    '[vars]\nARTIFACT_HOST_SUFFIX = "pages.example.com"\n',
  );
  assert.equal(noRoute.ok, false);
});
