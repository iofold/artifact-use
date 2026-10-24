// Security regression tests; synthetic data only.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, bearer } from "./security-review/fixture.ts";
import { nowSec } from "../src/util.ts";
import { createShareLinkFromInput } from "../src/admin.ts";
import { verifyViewerSession } from "../src/auth.ts";
import { hashPasscode } from "../src/links.ts";
import { proxyUpstream } from "../src/upstream.ts";

test("recipient links cannot read or change a global verified profile", async () => {
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
  assert.doesNotMatch(await profile.text(), /ORIGINAL_PRIVATE_NAME/);
  const comment = await f.request("/_au/comments", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      artifact_key: attacker.url_key,
      body: "Synthetic reviewer comment",
    }),
  });
  assert.equal(comment.status, 200);
  assert.doesNotMatch(await comment.text(), /ORIGINAL_PRIVATE_NAME/);
  const set = await f.request("/_au/profile", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      artifact_key: attacker.url_key,
      display_name: "ATTACKER_CHOSEN_NAME",
    }),
  });
  assert.equal(
    set.status,
    200,
    "recipient reviewers retain artifact-scoped name editing",
  );
  assert.match(await set.text(), /ATTACKER_CHOSEN_NAME/);
  const localComments = await f.request(
    `/_au/comments?artifact_key=${attacker.url_key}`,
    { headers: bearer(token) },
  );
  assert.match(await localComments.text(), /ATTACKER_CHOSEN_NAME/);
  const victimProfile = await f.request(
    `/_au/profile?artifact_key=${victim.url_key}`,
    { headers: bearer(await f.viewer(victim)) },
  );
  assert.match(await victimProfile.text(), /ORIGINAL_PRIVATE_NAME/);
});

test("read-only statistics omit share-link credentials", async () => {
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
  assert.doesNotMatch(await stats.text(), /syntheticopencredential/);
});

test("delegated tokens cannot mint further tokens", async () => {
  const f = fixture();
  const a = f.artifact("art_renew");
  const originalExpiry = nowSec() + 60;
  const token = await f.viewer(a, { agent: "delegated", exp: originalExpiry });
  const renew = await f.request("/_au/agent-token", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: a.url_key }),
  });
  assert.equal(renew.status, 403);
  assert.equal((await renew.json()).error.code, "delegation_forbidden");
});

test("upstream requests never automatically forward secrets through redirects", async () => {
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
    assert.equal(captured?.redirect, "manual");
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

test("removed allowlist identities lose files, comments, and token minting", async () => {
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
    401,
  );
  const comments = await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
    headers: bearer(token),
  });
  assert.equal(comments.status, 401);
  assert.doesNotMatch(await comments.text(), /PRIVATE_COMMENT/);
  const delegated = await f.request("/_au/agent-token", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ artifact_key: a.url_key }),
  });
  assert.equal(delegated.status, 403);
});

test("both OTP redemption routes enforce the current allowlist", async () => {
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
  assert.equal(post.status, 403);
  assert.equal(((await post.json()) as { token?: string }).token, undefined);
  const get = await f.request("/_au/gate/verify?t=synthetic_get");
  assert.equal(get.status, 403);
  assert.equal(((await get.json()) as { token?: string }).token, undefined);
});

test("pinned credentials honor a fresh membership removal", async () => {
  const f = fixture();
  f.env.WORKOS_API_KEY = "synthetic-unused-key";
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
    403,
  );
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: bearer(token),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(`/_au/comments?artifact_key=${a.url_key}`, {
        headers: bearer(token),
      })
    ).status,
    401,
  );
});

test("share-link max_opens is atomic across concurrent redemptions", async () => {
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
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(
    (
      f.raw
        .prepare(
          "SELECT open_count FROM share_links WHERE id='syntheticlimitedlink'",
        )
        .get() as { open_count: number }
    ).open_count,
    1,
  );
});

test("password guessing is bounded across IP addresses", async () => {
  const f = fixture();
  const a = f.artifact("art_password_global");
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
  for (let ip = 1; ip <= 3; ip++)
    for (let n = 0; n < 10; n++)
      assert.equal(
        (
          await f.form("/_au/gate/link", values, {
            "CF-Connecting-IP": `192.0.2.${ip}`,
          })
        ).status,
        401,
      );
  assert.equal(
    (
      await f.form(
        "/_au/gate/link",
        { ...values, passcode: "123456" },
        { "CF-Connecting-IP": "192.0.2.4" },
      )
    ).status,
    429,
  );
});
