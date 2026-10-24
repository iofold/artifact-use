import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./security-review/fixture.ts";
import {
  viewerCookieName,
  setViewerCookie,
  issueAdminCsrfToken,
} from "../src/auth.ts";
import {
  viewerIdentityCookie,
  googleStateCookie,
} from "../src/viewer-identity.ts";
import { nowSec } from "../src/util.ts";

test("viewer sessions use browser-enforced host cookies and ignore shadowable legacy names", async () => {
  const f = fixture();
  const a = f.artifact("art_cookie");
  const token = await f.viewer(a);
  assert.equal(viewerCookieName(a.id), "__Host-au_art_cookie");
  const cookie = setViewerCookie(viewerCookieName(a.id), token);
  assert.match(cookie, /^__Host-/);
  assert.match(cookie, /; Path=\/;/);
  assert.match(cookie, /; Secure;/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: { Cookie: `au_art_cookie=${encodeURIComponent(token)}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(`/go/${a.url_key}/private.txt`, {
        headers: { Cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
});

test("publisher, identity, state and CSRF cookies cannot be set by a sibling domain", async () => {
  const f = fixture();
  const legacy = await f.request("/admin/api/overview", {
    headers: { Cookie: `au_pub=${encodeURIComponent(await f.publisher())}` },
  });
  assert.equal(legacy.status, 401);
  const cookies = [
    (await issueAdminCsrfToken("synthetic", nowSec() + 600, f.env)).cookie,
    await viewerIdentityCookie(f.env, "victim@example.com", "user_AUDIT"),
    await googleStateCookie(f.env, {
      state: "synthetic",
      artifact_id: "art_cookie",
      redirect_to: "/go/cookie-abcdef/",
      share_link_id: null,
    }),
  ];
  for (const cookie of cookies) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /; Path=\/;/);
    assert.match(cookie, /; Secure;/);
    assert.doesNotMatch(cookie, /Domain=/i);
  }
});
