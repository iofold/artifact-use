import assert from "node:assert/strict";
import test from "node:test";
import { fixture, bearer } from "./security-review/fixture.ts";
import { artifactUrlKey, nowSec } from "../src/util.ts";
import { cacheControl } from "../src/serve.ts";
import {
  renderPreviewCardHtml,
  artifactPreviewImageUrl,
} from "../src/preview.ts";

test("protected gate and preview metadata do not disclose title, description, version, or presence", async () => {
  const f = fixture();
  const a = f.artifact("art_metadata");
  a.title = "SECRET_TITLE";
  a.description = "SECRET_PARAGRAPH";
  f.raw
    .prepare("UPDATE artifacts SET title=?,description=? WHERE id=?")
    .run(a.title, a.description, a.id);
  f.raw
    .prepare(
      "INSERT INTO artifact_watch (artifact_id,last_seen_at,label) VALUES (?,?,'SECRET_AGENT_LABEL')",
    )
    .run(a.id, nowSec());
  for (const headers of [
    { Accept: "text/html" },
    { "User-Agent": "Slackbot" },
  ]) {
    const r = await f.request(`/go/${a.url_key}/`, { headers });
    const html = await r.text();
    assert.doesNotMatch(html, /SECRET_TITLE|SECRET_PARAGRAPH|ver_art_metadata/);
  }
  assert.doesNotMatch(
    renderPreviewCardHtml(f.env, a, "text/html"),
    /SECRET_TITLE|SECRET_PARAGRAPH/,
  );
  assert.doesNotMatch(artifactPreviewImageUrl(f.env, a), /ver_art_metadata/);
  const context = await f.request(
    `/_au/artifact-context?artifact_key=${a.url_key}`,
  );
  assert.equal(context.status, 401);
  assert.doesNotMatch(await context.text(), /SECRET_AGENT_LABEL/);
  assert.equal(
    (
      await f.request(`/_au/artifact-context?artifact_key=${a.url_key}`, {
        headers: bearer(await f.viewer(a)),
      })
    ).status,
    200,
  );
});

test("new artifact URLs retain 128 random bits while old URLs remain valid", async () => {
  const f = fixture();
  const key = artifactUrlKey(
    "readable-".repeat(7).slice(0, 60),
    "art_0123456789abcdef0123456789abcdef",
  );
  assert.match(key, /-0123456789abcdef0123456789abcdef$/);
  assert.ok(key.length <= 63);
  const a = f.artifact("art_legacy", "org_other", "public");
  assert.equal((await f.request(`/go/${a.url_key}/private.txt`)).status, 200);
  f.raw.prepare("UPDATE artifacts SET url_key=? WHERE id=?").run(key, a.id);
  assert.equal((await f.request(`/go/${key}/private.txt`)).status, 200);
});

test("protected assets always revalidate authorization instead of retaining immutable cache entries", () => {
  assert.equal(
    cacheControl("allowlist", false, "assets/private-abcdefgh1234.json"),
    "private, no-store",
  );
  assert.equal(
    cacheControl("public", false, "assets/app-abcdefgh1234.js"),
    "public, max-age=31536000, immutable",
  );
});

test("failed artifact discovery is bounded across keys on the same IP", async () => {
  const f = fixture();
  f.env.ARTIFACT_HOST_SUFFIX = "pages.example";
  for (let i = 0; i < 60; i++)
    assert.equal(
      (
        await f.request(`/go/missing-${i}/`, {
          headers: { "CF-Connecting-IP": "192.0.2.80" },
        })
      ).status,
      404,
    );
  const a = f.artifact("art_discovery", "org_other", "public");
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: { "CF-Connecting-IP": "192.0.2.80" },
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: { "CF-Connecting-IP": "192.0.2.81" },
      })
    ).status,
    200,
  );
});
