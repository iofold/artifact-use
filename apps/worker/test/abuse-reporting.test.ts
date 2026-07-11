import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { abuseMailto } from "../src/abuse.ts";
import {
  renderHome,
  renderPrivacyPolicy,
  renderTermsOfService,
} from "../src/publisher.ts";
import { injectWidget } from "../src/serve.ts";
import type { Artifact, Env } from "../src/types.ts";
import { FEEDBACK_WIDGET_JS } from "../src/widget/feedback.generated.ts";

const env = {
  ABUSE_EMAIL: "abuse@example.com",
  SITE_BASE_URL: "https://artifacts.example.com",
  ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
} as Env;

const artifact = {
  id: "art_abuse",
  org_id: "org_abuse",
  slug: "report-demo",
  url_key: "report-demo-abc123",
  title: "Report demo",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_abuse",
  created_by: "user_abuse",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

test("abuse mail links use only validated configured addresses", () => {
  const url = abuseMailto(env);
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "mailto:");
  assert.equal(parsed.pathname, "abuse@example.com");
  assert.equal(parsed.searchParams.get("subject"), "Report abuse");

  assert.equal(abuseMailto({ ...env, ABUSE_EMAIL: "" }), null);
  assert.equal(
    abuseMailto({ ...env, ABUSE_EMAIL: 'attacker@example.com" onclick="x' }),
    null,
  );
});

test("artifact report links prefill the stable URL and key without credentials", () => {
  const url = abuseMailto(env, {
    artifactKey: artifact.url_key,
    artifactUrl: `https://artifacts.example.com/go/${artifact.url_key}/`,
  });
  assert.ok(url);
  const parsed = new URL(url);
  assert.match(parsed.searchParams.get("subject") || "", /report-demo-abc123/);
  const body = parsed.searchParams.get("body") || "";
  assert.match(body, /Artifact key: report-demo-abc123/);
  assert.match(
    body,
    /https:\/\/artifacts\.example\.com\/go\/report-demo-abc123\//,
  );
  assert.doesNotMatch(body, /agent=|bearer|token/i);
});

test("homepage and legal pages expose the configured reporting channel", async () => {
  const home = await (
    await renderHome(new Request("https://artifacts.example.com/"), env)
  ).text();
  const privacy = await renderPrivacyPolicy(env).text();
  const terms = await renderTermsOfService(env).text();

  for (const [name, html] of [
    ["home", home],
    ["privacy", privacy],
    ["terms", terms],
  ]) {
    assert.match(html, /Report abuse/i, name);
    assert.match(html, /mailto:abuse@example\.com/i, name);
  }
  assert.match(terms, /Abuse and copyright reports/i);
  assert.match(terms, /temporarily restrict access/i);
  assert.match(terms, /publisher may respond/i);
  assert.doesNotMatch(terms, /DMCA safe harbor|safe-harbor compliant/i);
});

test("injected widget carries a credential-free artifact report link", () => {
  const html = injectWidget(
    "<!doctype html><html><body><h1>Artifact</h1></body></html>",
    artifact,
    "ver_abuse",
    env,
  );
  assert.match(html, /"abuseUrl":"mailto:abuse@example\.com/);
  assert.doesNotMatch(html, /agent=|au_creator_|Bearer /i);
  assert.match(FEEDBACK_WIDGET_JS, /Report abuse/);
  assert.match(FEEDBACK_WIDGET_JS, /data-report-abuse/);
});

test("deployment guidance and response runbook cover the operational handoff", async () => {
  const [wrangler, deploy, runbook] = await Promise.all([
    readFile("apps/worker/wrangler.toml", "utf8"),
    readFile("docs/DEPLOY.md", "utf8"),
    readFile("docs/ABUSE_RESPONSE.md", "utf8"),
  ]);
  assert.match(wrangler, /^ABUSE_EMAIL\s*=\s*"abuse@example\.com"$/m);
  assert.match(deploy, /Browser Integrity Check/i);
  assert.match(deploy, /\bbic\b/);
  assert.match(deploy, /\/api\/v1\/\*/);
  assert.match(deploy, /\/_au\/\*/);
  for (const topic of [
    "intake",
    "evidence",
    "suspend",
    "publisher",
    "restore",
    "escalat",
    "incident log",
  ])
    assert.match(runbook, new RegExp(topic, "i"), topic);
  assert.match(runbook, /\/admin\/super/);
});
