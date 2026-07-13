import assert from "node:assert/strict";
import test from "node:test";
import type { Env, PublisherSession } from "../src/types.ts";
import * as auth from "../src/auth.ts";
import worker from "../src/index.ts";
import * as util from "../src/util.ts";

// The WorkOS AuthKit app points its initiate-login and logout URIs at /login,
// and /login re-enters WorkOS. These tests pin the worker-side defenses that
// keep that ring from ever becoming ERR_TOO_MANY_REDIRECTS in a browser.

const testEnv = {
  SESSION_SECRET: "auth-loop-test-secret",
  SITE_BASE_URL: "https://artifacts.example.com",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
} as Env;

function browserRequest(path: string, cookie = ""): Request {
  const headers = new Headers({ Accept: "text/html" });
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`https://artifacts.example.com${path}`, { headers });
}

function setCookieValue(response: Response, name: string): string | null {
  for (const value of response.headers.getSetCookie()) {
    if (value.startsWith(`${name}=`)) return value;
  }
  return null;
}

async function publisherCookie(): Promise<string> {
  const session: PublisherSession = {
    typ: "publisher",
    sub: "user_test",
    orgId: "org_test",
    email: "owner@example.com",
    name: "Owner",
    exp: util.nowSec() + 600,
  };
  return `au_pub=${encodeURIComponent(await auth.signPayload(session, testEnv))}`;
}

test("/login without a session redirects to WorkOS and counts the hop", async () => {
  const response = await worker.fetch(browserRequest("/login"), testEnv);
  assert.equal(response.status, 302);
  assert.match(
    response.headers.get("Location") || "",
    /^https:\/\/api\.workos\.com\/user_management\/authorize\?/,
  );
  const loop = setCookieValue(response, "au_loop");
  assert.ok(loop, "each automatic sign-in entry must be counted");
  assert.match(loop, /^au_loop=1;/);
  assert.match(loop, /Max-Age=60/);
});

test("/login stops redirecting after the loop limit and renders a page", async () => {
  let hops = 0;
  let response: Response | null = null;
  // Simulate the browser looping: feed each response's au_loop back in.
  let cookie = "";
  for (; hops < 10; hops++) {
    response = await worker.fetch(browserRequest("/login", cookie), testEnv);
    if (response.status !== 302) break;
    const loop = setCookieValue(response, "au_loop");
    assert.ok(loop);
    cookie = `au_loop=${/^au_loop=([^;]*)/.exec(loop)?.[1]}`;
  }
  assert.ok(response);
  assert.equal(response.status, 200, "the ring must terminate in a 200 page");
  assert.equal(hops, 2, "exactly LOOP_LIMIT automatic redirects are allowed");
  assert.match(await response.text(), /Continue to sign in/);
  // The stop page resets the counter so a human click gets a fresh budget.
  assert.match(setCookieValue(response, "au_loop") || "", /Max-Age=0/);
});

test("/login with a valid publisher session goes to /admin, not WorkOS", async () => {
  const response = await worker.fetch(
    browserRequest("/login", await publisherCookie()),
    testEnv,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/admin");
});

test("/login with a session honors a safe pre-auth destination", async () => {
  const cookie = `${await publisherCookie()}; au_next=${encodeURIComponent("/admin/connect?code=ABCD-2345")}`;
  const response = await worker.fetch(browserRequest("/login", cookie), testEnv);
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "/admin/connect?code=ABCD-2345",
  );
});

test("callback with a mismatched state restarts sign-in instead of dead-ending", async () => {
  const response = await worker.fetch(
    browserRequest("/callback?code=01TESTCODE&state=st_stale", "au_state=st_other"),
    testEnv,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/login");
  // The failed attempt must clear its state cookies so the retry is clean.
  assert.match(setCookieValue(response, "au_state") || "", /Max-Age=0/);
});

test("callback with an OAuth error still renders the failure page", async () => {
  const response = await worker.fetch(
    browserRequest("/callback?error=access_denied"),
    testEnv,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sign in failed/);
});
