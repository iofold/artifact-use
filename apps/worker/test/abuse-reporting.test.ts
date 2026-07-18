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

test("homepage exposes the configured reporting channel", async () => {
  const home = await (
    await renderHome(new Request("https://artifacts.example.com/"), env)
  ).text();
  assert.match(home, /Report abuse/i);
  assert.match(home, /mailto:abuse@example\.com/i);
});

test("unconfigured operator policies stay hidden and return 404", async () => {
  const home = await (
    await renderHome(new Request("https://artifacts.example.com/"), env)
  ).text();
  assert.doesNotMatch(home, /href="\/privacy"/);
  assert.doesNotMatch(home, /href="\/terms"/);

  for (const response of [
    renderPrivacyPolicy(env),
    renderTermsOfService(env),
  ]) {
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.match(body, /not configured for this deployment/i);
    assert.doesNotMatch(body, /Iofold|hello@iofold\.com|laws of India/i);
  }
});

test("configured operator policies are linked and redirect externally", async () => {
  const configured = {
    ...env,
    ARTIFACT_USE_PRIVACY_URL: "https://example.com/legal/privacy",
    ARTIFACT_USE_TERMS_URL: "https://example.com/legal/terms",
  } as Env;
  const home = await (
    await renderHome(new Request("https://artifacts.example.com/"), configured)
  ).text();
  assert.match(home, /href="https:\/\/example\.com\/legal\/privacy"/);
  assert.match(home, /href="https:\/\/example\.com\/legal\/terms"/);

  const privacy = renderPrivacyPolicy(configured);
  assert.equal(privacy.status, 302);
  assert.equal(
    privacy.headers.get("Location"),
    configured.ARTIFACT_USE_PRIVACY_URL,
  );

  const terms = renderTermsOfService(configured);
  assert.equal(terms.status, 302);
  assert.equal(
    terms.headers.get("Location"),
    configured.ARTIFACT_USE_TERMS_URL,
  );
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
  const [wrangler, deploy] = await Promise.all([
    readFile("apps/worker/wrangler.toml", "utf8"),
    readFile("docs/DEPLOY.md", "utf8"),
  ]);
  assert.match(wrangler, /^ABUSE_EMAIL\s*=\s*"abuse@example\.com"$/m);
  assert.match(deploy, /Browser Integrity Check/i);
  assert.match(deploy, /\bbic\b/);
  assert.match(deploy, /\/api\/v1\/\*/);
  assert.match(deploy, /\/_au\/\*/);
  // The operator runbook lives in gitignored docs/internal/ and only exists on
  // maintainer checkouts; public clones skip its coverage assertions.
  const runbook = await readFile(
    "docs/internal/ABUSE_RESPONSE.md",
    "utf8",
  ).catch(() => null);
  if (runbook === null) return;
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

test("self-hosted admin errors defer to the deployment operator", async () => {
  const dashboard = await readFile(
    "apps/admin-ui/src/pages/Dashboard.tsx",
    "utf8",
  );
  assert.doesNotMatch(dashboard, /mailto:hello@iofold\.com/);
  assert.match(dashboard, /deployment operator/i);
});
