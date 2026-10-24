// Diagnostic probes of the reviewed revision, deliberately outside *.test.ts.
// A passing FINDING probe reproduces a vulnerability, not a security guarantee.
// Run: node --import tsx --test apps/worker/test/security-review/probes.ts
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, bearer } from "./fixture.ts";
import { nowSec, artifactUrlKey } from "../../src/util.ts";
import { getArtifactById } from "../../src/db.ts";
import { createShareLinkFromInput } from "../../src/admin.ts";
import { verifyViewerSession, getCreator } from "../../src/auth.ts";
import { hashPasscode } from "../../src/links.ts";
import { proxyUpstream } from "../../src/upstream.ts";

test("FINDING: removed allowlist identity retains files, comments, and token minting", async () => {
  const f = fixture();
  const a = f.artifact("art_acl");
  const token = await f.viewer(a);
  f.raw
    .prepare("UPDATE artifacts SET allowlist_json = ? WHERE id = ?")
    .run(JSON.stringify({ emails: ["someoneelse@example.com"] }), a.id);
  f.raw
    .prepare(
      "INSERT INTO comments (artifact_id,email,body,created_at,private_to) VALUES (?, 'victim@example.com','PRIVATE_COMMENT',1,'victim@example.com')",
    )
    .run(a.id);
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: bearer(token),
      })
    ).status,
    200,
  );
  const comments = await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
    headers: bearer(token),
  });
  assert.match(await comments.text(), /PRIVATE_COMMENT/);
  const delegated = await f.request("/_au/agent-token", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: a.url_key }),
  });
  assert.equal(delegated.status, 200);
});

test("FINDING: both OTP redemption routes ignore a changed allowlist", async () => {
  const f = fixture();
  const a = f.artifact("art_otp");
  for (const [token, code] of [
    ["synthetic_post", "123456"],
    ["synthetic_get", "654321"],
  ]) {
    f.raw
      .prepare(
        "INSERT INTO viewer_tokens (token,artifact_id,email,code,expires_at,created_at) VALUES (?,?,'victim@example.com',?,?,?)",
      )
      .run(token, a.id, code, nowSec() + 600, nowSec());
  }
  f.raw
    .prepare(
      "UPDATE artifacts SET allowlist_json = '{\"emails\":[]}' WHERE id = ?",
    )
    .run(a.id);
  const post = await f.form("/_au/gate/verify", {
    artifact_key: a.url_key,
    email: "victim@example.com",
    code: "123456",
  });
  assert.equal(post.status, 200);
  assert.ok(((await post.json()) as { token?: string }).token);
  const get = await f.request("/_au/gate/verify?t=synthetic_get");
  assert.equal(get.status, 200);
  assert.ok(((await get.json()) as { token?: string }).token);
});

test("FINDING: protected metadata and agent presence are readable without authentication", async () => {
  const f = fixture();
  const a = f.artifact("art_metadata");
  f.raw
    .prepare(
      "UPDATE artifacts SET description='CONFIDENTIAL_FIRST_PARAGRAPH' WHERE id=?",
    )
    .run(a.id);
  f.raw
    .prepare(
      "INSERT INTO artifact_watch (artifact_id,last_seen_at,label) VALUES (?,?,'PRIVATE_AGENT_LABEL')",
    )
    .run(a.id, nowSec());
  const gate = await f.request(`/go/${a.url_key}/`, {
    headers: { Accept: "text/html" },
  });
  assert.match(await gate.text(), /CONFIDENTIAL_FIRST_PARAGRAPH/);
  const bot = await f.request(`/go/${a.url_key}/`, {
    headers: { "User-Agent": "Slackbot" },
  });
  assert.match(await bot.text(), /CONFIDENTIAL_FIRST_PARAGRAPH/);
  const context = await f.request(
    `/_au/artifact-context?artifact_key=${a.url_key}`,
  );
  assert.match(await context.text(), /PRIVATE_AGENT_LABEL/);
  assert.equal(
    artifactUrlKey("known-title", "art_0123456789abcdef0123456789abcdef"),
    "known-title-012345",
  );
});

test("FINDING: a recipient link in tenant A can change a person's name in tenant B", async () => {
  const f = fixture();
  const attacker = f.artifact("art_profile_attacker", "org_attacker");
  const victim = f.artifact("art_profile_victim");
  f.raw
    .prepare(
      "INSERT INTO profiles (email,display_name,updated_at) VALUES ('victim@example.com','ORIGINAL_PRIVATE_NAME',1)",
    )
    .run();
  const link = await createShareLinkFromInput(
    f.env,
    attacker,
    {
      sub: "user_ATTACKER",
      orgId: "org_attacker",
      email: "attacker@example.com",
      permissions: new Set(["artifacts:manage_access"]),
      raw: {},
    },
    { kind: "recipient", recipient_email: "victim@example.com" },
  );
  assert.ok(!(link instanceof Response));
  const redeem = await f.form("/_au/gate/link", {
    artifact_key: attacker.url_key,
    link: String(link.id),
  });
  const { token } = (await redeem.json()) as { token: string };
  assert.equal((await verifyViewerSession(token, f.env))?.verified, false);
  const profile = await f.request(
    `/_au/profile?artifact_key=${attacker.url_key}`,
    { headers: bearer(token) },
  );
  assert.match(await profile.text(), /ORIGINAL_PRIVATE_NAME/);
  const set = await f.request("/_au/profile", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      artifact_key: attacker.url_key,
      display_name: "ATTACKER_CHOSEN_NAME",
    }),
  });
  assert.equal(set.status, 200);
  const victimProfile = await f.request(
    `/_au/profile?artifact_key=${victim.url_key}`,
    { headers: bearer(await f.viewer(victim)) },
  );
  assert.match(await victimProfile.text(), /ATTACKER_CHOSEN_NAME/);
});

test("FINDING: read-only artifact statistics disclose reusable share-link credentials", async () => {
  const f = fixture();
  const a = f.artifact("art_stats");
  f.raw
    .prepare(
      "INSERT INTO share_links (id,artifact_id,kind,created_by,created_at) VALUES ('syntheticopencredential',?,'open','user_AUDIT',1)",
    )
    .run(a.id);
  const token = await f.creator("org_victim", ["artifacts:read"]);
  const direct = await f.request(`/api/v1/artifacts/${a.url_key}/share-links`, {
    headers: bearer(token),
  });
  assert.notEqual(direct.status, 200);
  const stats = await f.request(`/api/v1/artifacts/${a.url_key}/stats`, {
    headers: bearer(token),
  });
  assert.equal(stats.status, 200);
  assert.match(await stats.text(), /syntheticopencredential/);
});

test("FINDING: a delegated token can renew itself beyond its original expiry", async () => {
  const f = fixture();
  const a = f.artifact("art_renew");
  const originalExpiry = nowSec() + 60;
  const token = await f.viewer(a, { agent: "delegated", exp: originalExpiry });
  const renew = await f.request("/_au/agent-token", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: a.url_key }),
  });
  const next = (await renew.json()) as { token: string; expires_at: number };
  assert.equal(renew.status, 200);
  assert.ok(next.expires_at > originalExpiry + 80000);
  assert.equal(
    (await verifyViewerSession(next.token, f.env))?.agent,
    "delegated",
  );
});

test("FINDING: a fresh membership snapshot removing a user does not revoke their pinned credential", async () => {
  const f = fixture();
  const a = f.artifact("art_membership");
  const token = await f.creator();
  f.raw
    .prepare(
      "INSERT INTO workspace_membership_sync (user_id,refreshed_at) VALUES ('user_AUDIT',?)",
    )
    .run(nowSec());
  assert.equal(
    (
      await f.request(`/api/v1/artifacts/${a.url_key}`, {
        headers: bearer(token),
      })
    ).status,
    200,
  );
  const auth = await getCreator(
    new Request("https://audit.example/api/v1/artifacts", {
      headers: bearer(token),
    }),
    f.env,
  );
  assert.equal(auth?.orgId, "org_victim");
});

test("FINDING: ten password guesses exhaust one IP but another IP has a fresh budget", async () => {
  const f = fixture();
  const a = f.artifact("art_password");
  const salt = "01".repeat(16);
  f.raw
    .prepare(
      "INSERT INTO share_links (id,artifact_id,kind,password_salt,password_hash,created_by,created_at) VALUES ('syntheticpasswordlink',?,'password',?,?,'user_AUDIT',1)",
    )
    .run(a.id, salt, await hashPasscode("123456", salt));
  const values = {
    artifact_key: a.url_key,
    link: "syntheticpasswordlink",
    passcode: "wrong-password",
  };
  for (let i = 0; i < 10; i++)
    assert.equal((await f.form("/_au/gate/link", values)).status, 401);
  assert.equal((await f.form("/_au/gate/link", values)).status, 429);
  assert.equal(
    (
      await f.form(
        "/_au/gate/link",
        { ...values, passcode: "123456" },
        { "CF-Connecting-IP": "192.0.2.2" },
      )
    ).status,
    200,
  );
});

test("FINDING: parallel redemptions exceed max_opens=1", async () => {
  const f = fixture();
  const a = f.artifact("art_limit");
  f.raw
    .prepare(
      "INSERT INTO share_links (id,artifact_id,kind,max_opens,created_by,created_at) VALUES ('syntheticlimitedlink',?,'open',1,'user_AUDIT',1)",
    )
    .run(a.id);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.form("/_au/gate/link", {
        artifact_key: a.url_key,
        link: "syntheticlimitedlink",
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 8);
  assert.equal(
    (
      f.raw
        .prepare(
          "SELECT open_count FROM share_links WHERE id='syntheticlimitedlink'",
        )
        .get() as { open_count: number }
    ).open_count,
    8,
  );
});

test("FINDING: upstream request opts into redirect following with its secret and viewer identity", async () => {
  const f = fixture();
  const a = f.artifact("art_upstream");
  f.raw
    .prepare(
      "INSERT INTO artifact_upstreams (artifact_id,base_url,secret,created_at,updated_at) VALUES (?,'https://backend.example','SYNTHETIC_UPSTREAM_SECRET',1,1)",
    )
    .run(a.id);
  const original = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    captured = init;
    return new Response("synthetic");
  };
  try {
    const response = await proxyUpstream(
      new Request(`https://audit.example/go/${a.url_key}/_api/redirect`),
      f.env,
      a,
      {
        artifact_id: a.id,
        version_id: a.current_version_id,
        email: "victim@example.com",
        verified: true,
        view_id: 1,
        exp: nowSec() + 100,
      },
      ["redirect"],
    );
    assert.equal(response.status, 200);
    assert.equal(captured?.redirect, "follow");
    assert.equal(
      new Headers(captured?.headers).get("Authorization"),
      "Bearer SYNTHETIC_UPSTREAM_SECRET",
    );
    assert.equal(
      new Headers(captured?.headers).get("X-Artifact-Viewer-Email"),
      "victim@example.com",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("CONTROL: wrong-tenant credentials, wrong-artifact tokens, anonymous files, and traversal are denied", async () => {
  const f = fixture();
  const a = f.artifact("art_control_a");
  const b = f.artifact("art_control_b", "org_other");
  assert.equal(
    (
      await f.request(`/api/v1/artifacts/${a.url_key}`, {
        headers: bearer(await f.creator("org_other")),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: bearer(await f.viewer(b)),
      })
    ).status,
    401,
  );
  assert.equal((await f.request(`/go/${a.url_key}/private.txt`)).status, 401);
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/%2e%2e%2fprivate.txt`, {
        headers: bearer(await f.viewer(a)),
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request(`/go/${a.url_key}/_au/index.json`)).status,
    401,
  );
});

test("CONTROL: private comment roots isolate viewers and link revocation invalidates comments", async () => {
  const f = fixture();
  const a = f.artifact("art_control_comments");
  f.raw
    .prepare(
      "INSERT INTO comments (artifact_id,email,body,created_at,private_to) VALUES (?,'other@example.com','OTHER_PRIVATE_COMMENT',1,'other@example.com')",
    )
    .run(a.id);
  const response = await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
    headers: bearer(await f.viewer(a)),
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /OTHER_PRIVATE_COMMENT/);
  f.raw
    .prepare(
      "INSERT INTO share_links (id,artifact_id,kind,revoked_at,created_by,created_at) VALUES ('syntheticrevokedlink',?,'open',1,'user_AUDIT',1)",
    )
    .run(a.id);
  assert.equal(
    (
      await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
        headers: bearer(await f.viewer(a, { link_id: "syntheticrevokedlink" })),
      })
    ).status,
    401,
  );
  assert.ok(await getArtifactById(f.env, a.id));
});
