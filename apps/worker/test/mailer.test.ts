import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sendVerificationEmail } from "../src/mailer.ts";
import type { Artifact, Env } from "../src/types.ts";

const artifact = {
  id: "art_mail",
  org_id: "org_mail",
  slug: "mail-demo",
  url_key: "mail-demo-abc123",
  title: "Mail <demo>",
  description: null,
  gate_level: "verified_email",
  allowlist_json: null,
  current_version_id: "ver_mail",
  created_by: "user_mail",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

test("verification mail uses the native Cloudflare binding", async () => {
  const sent: unknown[] = [];
  const env = {
    EMAIL: {
      async send(message: unknown) {
        sent.push(message);
        return { messageId: "mail_test" };
      },
    },
    MAIL_FROM: "artifacts@updates.iofold.com",
    MAIL_FROM_NAME: "Artifact Use",
  } as unknown as Env;

  await sendVerificationEmail(
    env,
    artifact,
    "viewer@example.com",
    "123456",
    "https://artifacts.iofold.com/_au/gate/verify?t=vt_test",
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    from: {
      email: "artifacts@updates.iofold.com",
      name: "Artifact Use",
    },
    to: "viewer@example.com",
    subject: "Your access code for Mail <demo>",
    text: [
      "Use this code to view Mail <demo>: 123456",
      "Open this link: https://artifacts.iofold.com/_au/gate/verify?t=vt_test",
    ].join("\n\n"),
    html: [
      "<p>Use this code to view <strong>Mail &lt;demo&gt;</strong>:</p>",
      '<p style="font-size:24px;font-weight:700;letter-spacing:4px">123456</p>',
      "<p>Or open this link:</p>",
      '<p><a href="https://artifacts.iofold.com/_au/gate/verify?t=vt_test">https://artifacts.iofold.com/_au/gate/verify?t=vt_test</a></p>',
    ].join("\n"),
  });
});

test("provider failures become a delivery error without public details", async () => {
  const providerError = Object.assign(
    new Error('429 {"message":"daily quota exceeded"}'),
    { code: "daily_quota_exceeded" },
  );
  const env = {
    EMAIL: {
      async send() {
        throw providerError;
      },
    },
    MAIL_FROM: "artifacts@updates.iofold.com",
  } as unknown as Env;

  await assert.rejects(
    () =>
      sendVerificationEmail(
        env,
        artifact,
        "viewer@example.com",
        "123456",
        "https://artifacts.iofold.com/_au/gate/verify?t=vt_test",
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "EmailDeliveryError");
      assert.equal(error.message, "verification email delivery failed");
      assert.doesNotMatch(error.message, /quota|cloudflare|429/i);
      return true;
    },
  );
});

test("a missing production binding is also a delivery error", async () => {
  await assert.rejects(
    () =>
      sendVerificationEmail(
        {} as Env,
        artifact,
        "viewer@example.com",
        "123456",
        "https://artifacts.iofold.com/_au/gate/verify?t=vt_test",
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "EmailDeliveryError");
      assert.equal(error.message, "verification email delivery failed");
      assert.doesNotMatch(error.message, /configured|binding/i);
      return true;
    },
  );
});

test("the Worker declares a native Email Sending binding", async () => {
  const config = await readFile("apps/worker/wrangler.toml", "utf8");

  assert.match(config, /\[\[send_email\]\][\s\S]*?^name\s*=\s*"EMAIL"$/m);
  assert.match(
    config,
    /^allowed_sender_addresses\s*=\s*\["artifacts@example\.com"\]$/m,
  );
  assert.doesNotMatch(config, /RESEND_API_KEY/);
});
