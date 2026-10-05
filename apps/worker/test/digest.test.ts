import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DIGEST_CRON,
  buildFeedbackDigest,
  digestConfig,
  isDigestCron,
  renderFeedbackDigest,
  sendFeedbackDigest,
} from "../src/digest.ts";
import type { Env } from "../src/types.ts";
import { sqliteD1 } from "./helpers/sqlite-d1.ts";

const NOW = 1_790_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;
const OURS = "org_ours";
const OTHER = "org_someone_else";

type Sent = { to: string; subject: string; text: string; html: string };

function setup(options: { vars?: Partial<Env>; emailFails?: boolean } = {}): {
  env: Env;
  raw: DatabaseSync;
  sent: Sent[];
} {
  const { db, raw } = sqliteD1();
  const sent: Sent[] = [];
  const env = {
    DB: db,
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    FEEDBACK_DIGEST_TO: "ops@example.com",
    FEEDBACK_DIGEST_ORGS: `${OURS}, org_ours_legacy`,
    EMAIL: {
      async send(message: {
        to: string;
        subject: string;
        text: string;
        html: string;
      }) {
        if (options.emailFails) throw new Error("quota");
        sent.push(message);
      },
    },
    ...options.vars,
  } as unknown as Env;
  const artifact = raw.prepare(
    `INSERT INTO artifacts (id, org_id, slug, url_key, title, created_by, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, 'user_01TEST', 1, 1, ?)`,
  );
  artifact.run(
    "art_claims",
    OURS,
    "claims",
    "claims-abc123",
    "Claims console",
    "active",
  );
  artifact.run(
    "art_omics",
    "org_ours_legacy",
    "omics",
    "omics-def456",
    "Omics <workbench>",
    "active",
  );
  artifact.run(
    "art_theirs",
    OTHER,
    "theirs",
    "theirs-0a0a0a",
    "Someone else's page",
    "active",
  );
  artifact.run(
    "art_gone",
    OURS,
    "gone",
    "gone-1b1b1b",
    "Suspended page",
    "suspended",
  );
  return { env, raw, sent };
}

let nextId = 1;
function comment(
  raw: DatabaseSync,
  fields: {
    artifact: string;
    email?: string;
    body: string;
    at: number;
    parent?: number;
    kind?: "human" | "agent";
    label?: string | null;
    resolvedAt?: number | null;
    deletedAt?: number | null;
    pagePath?: string | null;
  },
): number {
  const id = nextId++;
  raw
    .prepare(
      `INSERT INTO comments (id, artifact_id, email, body, created_at, parent_comment_id, author_kind, agent_label, resolved_at, deleted_at, page_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      fields.artifact,
      fields.email || "reviewer@client.com",
      fields.body,
      fields.at,
      fields.parent ?? null,
      fields.kind || "human",
      fields.label ?? null,
      fields.resolvedAt ?? null,
      fields.deletedAt ?? null,
      fields.pagePath ?? null,
    );
  return id;
}

test("the digest is off unless both recipients and workspaces are set", async () => {
  for (const vars of [
    { FEEDBACK_DIGEST_TO: "" },
    { FEEDBACK_DIGEST_ORGS: " , " },
  ]) {
    const { env, sent } = setup({ vars });
    assert.equal(digestConfig(env), null);
    assert.deepEqual(await sendFeedbackDigest(env, NOW), {
      sent: false,
      reason: "not_configured",
    });
    assert.equal(sent.length, 0);
  }
});

test("only the digest cron sends it; it can be moved with a var", () => {
  const { env } = setup();
  assert.equal(isDigestCron(env, DEFAULT_DIGEST_CRON), true);
  assert.equal(isDigestCron(env, "23 */6 * * *"), false);
  const moved = setup({ vars: { FEEDBACK_DIGEST_CRON: "30 2 * * *" } }).env;
  assert.equal(isDigestCron(moved, "30 2 * * *"), true);
  assert.equal(isDigestCron(moved, DEFAULT_DIGEST_CRON), false);
});

test("a day's feedback is grouped by artifact, scoped to our workspaces, with our agents counted apart", async () => {
  const { env, raw } = setup();
  const waitingRoot = comment(raw, {
    artifact: "art_claims",
    body: "The totals row double counts refunds",
    at: NOW - 3 * HOUR,
    pagePath: "/findings.html",
  });
  const answeredRoot = comment(raw, {
    artifact: "art_claims",
    email: "pm@client.com",
    body: "Can we sort by date?",
    at: NOW - 5 * HOUR,
  });
  // Our agent answers: activity, not feedback.
  comment(raw, {
    artifact: "art_claims",
    email: "agent@us.com",
    body: "Done, sorted.",
    at: NOW - 4 * HOUR,
    parent: answeredRoot,
    kind: "agent",
  });
  // The reviewer's own delegated agent is feedback.
  comment(raw, {
    artifact: "art_omics",
    email: "vijay@client.com",
    body: "Floats in reports/*.csv are not rounded",
    at: NOW - 2 * HOUR,
    kind: "agent",
    label: "delegated",
  });
  const resolvedRoot = comment(raw, {
    artifact: "art_omics",
    body: "Typo in the header",
    at: NOW - 20 * HOUR,
    resolvedAt: NOW - HOUR,
  });
  // Out of scope: another workspace, a suspended artifact, deleted, too old.
  comment(raw, { artifact: "art_theirs", body: "not ours", at: NOW - HOUR });
  comment(raw, { artifact: "art_gone", body: "suspended", at: NOW - HOUR });
  comment(raw, {
    artifact: "art_claims",
    body: "deleted",
    at: NOW - HOUR,
    deletedAt: NOW - 30 * 60,
  });
  comment(raw, {
    artifact: "art_claims",
    body: "yesterday's news",
    at: NOW - DAY - 60,
  });

  const digest = await buildFeedbackDigest(env, digestConfig(env)!, NOW);
  assert.equal(digest.newCount, 4);
  assert.equal(digest.people, 3);
  assert.equal(digest.agentReplies, 1);
  assert.equal(digest.resolved, 1);
  assert.deepEqual(
    digest.artifacts.map((a) => [a.title, a.items.length]),
    [
      ["Claims console", 2],
      ["Omics <workbench>", 2],
    ],
  );
  const claims = digest.artifacts[0]!;
  assert.equal(claims.url, "https://artifacts.example.com/go/claims-abc123/");
  assert.equal(
    claims.adminUrl,
    "https://artifacts.example.com/admin?open=art_claims",
  );
  const status = new Map(
    digest.artifacts.flatMap((a) => a.items.map((i) => [i.id, i.status])),
  );
  assert.equal(status.get(waitingRoot), "waiting");
  assert.equal(status.get(answeredRoot), "answered");
  assert.equal(status.get(resolvedRoot), "resolved");
  const delegated = digest.artifacts[1]!.items.find((i) =>
    i.excerpt.startsWith("Floats"),
  );
  assert.equal(delegated?.author, "vijay@client.com's agent");
});

test("threads still waiting are listed for 14 days, older ones only counted", async () => {
  const { env, raw } = setup();
  comment(raw, {
    artifact: "art_claims",
    body: "two days old",
    at: NOW - 2 * DAY,
  });
  comment(raw, {
    artifact: "art_omics",
    body: "ten days old",
    at: NOW - 10 * DAY,
  });
  const answered = comment(raw, {
    artifact: "art_claims",
    body: "three days old, answered",
    at: NOW - 3 * DAY,
  });
  comment(raw, {
    artifact: "art_claims",
    body: "On it",
    at: NOW - 3 * DAY + 60,
    parent: answered,
    kind: "agent",
  });
  comment(raw, { artifact: "art_claims", body: "June", at: NOW - 100 * DAY });
  comment(raw, { artifact: "art_claims", body: "May", at: NOW - 130 * DAY });

  const digest = await buildFeedbackDigest(env, digestConfig(env)!, NOW);
  assert.equal(digest.newCount, 0);
  assert.deepEqual(
    digest.waiting.flatMap((group) => group.items.map((w) => w.excerpt)),
    ["ten days old", "two days old"],
  );
  assert.equal(digest.waitingTotal, 2);
  assert.equal(digest.olderWaiting, 2);
});

test("the email escapes reviewer text, and plain text keeps it verbatim", async () => {
  const { env, raw } = setup();
  comment(raw, {
    artifact: "art_omics",
    body: `<img src=x onerror=alert(1)> "quoted" ${"long ".repeat(100)}`,
    at: NOW - HOUR,
    pagePath: "/go/omics-def456/clinician.html",
  });
  const email = renderFeedbackDigest(
    await buildFeedbackDigest(env, digestConfig(env)!, NOW),
  );
  assert.equal(email.subject, "Artifact feedback: 1 new comment on 1 artifact");
  assert.doesNotMatch(email.html, /<img src=x/);
  assert.match(email.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(email.html, /Omics &lt;workbench&gt;/);
  assert.match(email.text, /<img src=x onerror=alert\(1\)>/);
  // Excerpts are capped.
  assert.match(email.text, /…"/);
  assert.match(
    email.text,
    /Last 24 hours: 1 new comment on 1 artifact from 1 person/,
  );
  // Pages are named relative to the artifact and linked.
  assert.match(
    email.html,
    /href="https:\/\/artifacts\.example\.com\/go\/omics-def456\/clinician\.html"[^>]*>clinician\.html<\/a>/,
  );
});

test("a quiet day says so instead of listing zeros", async () => {
  const { env, raw } = setup();
  comment(raw, {
    artifact: "art_claims",
    body: "still open",
    at: NOW - 3 * DAY,
  });
  const email = renderFeedbackDigest(
    await buildFeedbackDigest(env, digestConfig(env)!, NOW),
  );
  assert.equal(
    email.subject,
    "Artifact feedback: no new comments · 1 waiting for a reply",
  );
  assert.match(
    email.text,
    /^No new comments in the last 24 hours\. 1 thread from the previous 14 days still has no reply\./,
  );
  assert.doesNotMatch(email.text, /\b0 /);
});

test("it sends once a day, skips quiet days, and gives the slot back on a delivery failure", async () => {
  const quiet = setup();
  assert.deepEqual(await sendFeedbackDigest(quiet.env, NOW), {
    sent: false,
    reason: "nothing_to_report",
  });
  assert.equal(quiet.sent.length, 0);

  const failing = setup({ emailFails: true });
  comment(failing.raw, { artifact: "art_claims", body: "hi", at: NOW - HOUR });
  assert.deepEqual(await sendFeedbackDigest(failing.env, NOW), {
    sent: false,
    reason: "delivery_failed",
  });
  const slot = failing.raw
    .prepare(
      "SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE 'digest:%'",
    )
    .get() as { n: number };
  assert.equal(slot.n, 0, "a failed send must not use up the day");

  const { env, raw, sent } = setup({
    vars: { FEEDBACK_DIGEST_TO: "a@example.com, b@example.com" },
  });
  comment(raw, { artifact: "art_claims", body: "hi", at: NOW - HOUR });
  const first = await sendFeedbackDigest(env, NOW);
  assert.equal(first.sent, true);
  assert.deepEqual(
    sent.map((m) => m.to),
    ["a@example.com", "b@example.com"],
  );
  assert.deepEqual(await sendFeedbackDigest(env, NOW + 60), {
    sent: false,
    reason: "already_sent_today",
  });
  assert.equal(sent.length, 2);
});
