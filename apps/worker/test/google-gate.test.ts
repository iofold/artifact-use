// "Continue with Google" on artifact gates (through WorkOS) and the viewer
// identity that keeps a Google-signed-in viewer one click from later gates.
import assert from "node:assert/strict";
import test from "node:test";
import { signPayload, verifyViewerSession } from "../src/auth.ts";
import { handleGateRoute } from "../src/gate.ts";
import { handleComments, servePublic } from "../src/serve.ts";
import type { Env, GateLevel } from "../src/types.ts";
import { nowSec } from "../src/util.ts";
import { viewerIdentityCookie } from "../src/viewer-identity.ts";
import { ORIGIN, feedbackEnv, seedArtifact } from "./helpers/feedback-env.ts";

const WORKOS = {
  GATE_GOOGLE_SIGNIN: "true",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
} as const;

function setup(
  gate: GateLevel = "verified_email",
  overrides: Partial<Env> = {},
  allowlist: string | null = null,
) {
  const { env, raw } = feedbackEnv({ ...WORKOS, ...overrides });
  seedArtifact(raw, {
    id: "art_g",
    url_key: "g-abc123",
    gate_level: gate,
    allowlist_json: allowlist,
  });
  seedArtifact(raw, {
    id: "art_g2",
    url_key: "g2-abc123",
    gate_level: "verified_email",
  });
  return { env, raw };
}

type WorkosReply = { status: number; body: Record<string, unknown> };

// Answers WorkOS authenticate with `reply`; membership lookups come back
// empty (the Google user is nobody's member).
function mockWorkos(reply: WorkosReply): {
  calls: { url: string; body: Record<string, unknown> }[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (url.includes("/user_management/authenticate"))
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/organization_memberships"))
      return new Response(JSON.stringify({ data: [], list_metadata: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function navigationHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "CF-Connecting-IP": "203.0.113.30",
    ...extra,
  });
}

async function gatePage(
  env: Env,
  key: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await servePublic(
    new Request(`${ORIGIN}/go/${key}/`, { headers: navigationHeaders(extra) }),
    env,
    `/go/${key}/`,
  );
  return res.text();
}

async function start(
  env: Env,
  key = "g-abc123",
  headers: Record<string, string> = {},
): Promise<Response> {
  const form = new URLSearchParams({
    artifact_key: key,
    redirect_to: `/go/${key}/report.html?tab=2`,
    share_link_id: "",
  });
  return handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/google/start`, {
      method: "POST",
      headers: navigationHeaders({
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${ORIGIN}/go/${key}/`,
        ...headers,
      }),
      body: form,
    }),
    env,
    "/_au/gate/google/start",
  );
}

function cookieValue(setCookie: string, name: string): string | null {
  const match = new RegExp(`(?:^|, )${name}=([^;]*)`).exec(setCookie);
  return match ? decodeURIComponent(match[1]) : null;
}

async function callback(
  env: Env,
  stateCookie: string | null,
  query: string,
): Promise<Response> {
  return handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/google/callback?${query}`, {
      headers: navigationHeaders(
        stateCookie
          ? { Cookie: `au_gstate=${encodeURIComponent(stateCookie)}` }
          : {},
      ),
    }),
    env,
    "/_au/gate/google/callback",
  );
}

// Start, then come back from Google with `reply` from WorkOS.
async function signIn(env: Env, reply: WorkosReply, key = "g-abc123") {
  const started = await start(env, key);
  const setCookie = started.headers.get("Set-Cookie") || "";
  const stateCookie = cookieValue(setCookie, "au_gstate");
  const state = new URL(started.headers.get("Location") || "").searchParams.get(
    "state",
  );
  const workos = mockWorkos(reply);
  try {
    const res = await callback(env, stateCookie, `code=abc&state=${state}`);
    return { res, workos };
  } finally {
    workos.restore();
  }
}

const verifiedAlice: WorkosReply = {
  status: 200,
  body: {
    user: {
      id: "user_01ALICE",
      email: "Alice@Gmail.com",
      email_verified: true,
    },
  },
};

test("email gates offer Continue with Google only when it is switched on", async () => {
  for (const gate of ["email", "verified_email", "allowlist"] as GateLevel[]) {
    const { env } = setup(gate);
    assert.match(await gatePage(env, "g-abc123"), /Continue with Google/);
  }
  const { env: off } = setup("verified_email", { GATE_GOOGLE_SIGNIN: "" });
  assert.doesNotMatch(await gatePage(off, "g-abc123"), /Continue with Google/);
});

test("start sends the browser straight to Google through WorkOS", async () => {
  const { env } = setup();
  const res = await start(env);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("Location") || "");
  assert.equal(
    location.origin + location.pathname,
    "https://api.workos.com/user_management/authorize",
  );
  assert.equal(location.searchParams.get("provider"), "GoogleOAuth");
  assert.equal(location.searchParams.get("client_id"), "client_test");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    `${ORIGIN}/_au/gate/google/callback`,
  );
  assert.ok(location.searchParams.get("state"));
  assert.match(
    res.headers.get("Set-Cookie") || "",
    /au_gstate=.*Path=\/_au\/gate\/google;.*HttpOnly/,
  );
});

test("start refuses anything but a click on the artifact's own gate page", async () => {
  const { env } = setup();
  assert.equal(
    (await start(env, "g-abc123", { Referer: `${ORIGIN}/go/other-zzz999/` }))
      .status,
    403,
  );
  assert.equal(
    (await start(env, "g-abc123", { "Sec-Fetch-Mode": "cors" })).status,
    403,
  );
  const { env: off } = setup("verified_email", { GATE_GOOGLE_SIGNIN: "false" });
  assert.equal((await start(off)).status, 404);
});

test("a verified Google email passes the gate as a verified session", async () => {
  const { env, raw } = setup();
  const { res, workos } = await signIn(env, verifiedAlice);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/go/g-abc123/report.html?tab=2");
  const setCookie = res.headers.get("Set-Cookie") || "";
  const session = await verifyViewerSession(
    cookieValue(setCookie, "au_art_g") || "",
    env,
  );
  assert.equal(session?.email, "alice@gmail.com");
  assert.equal(session?.verified, true);
  assert.ok(cookieValue(setCookie, "au_vid"), "viewer identity is set");
  assert.match(setCookie, /au_gstate=;/);
  const exchange = workos.calls.find((c) =>
    c.url.includes("/user_management/authenticate"),
  );
  assert.equal(exchange?.body.client_secret, "sk_test");
  assert.equal(exchange?.body.grant_type, "authorization_code");
  const view = raw
    .prepare("SELECT email, verified FROM views WHERE artifact_id = 'art_g'")
    .get() as { email: string; verified: number };
  assert.equal(view.email, "alice@gmail.com");
  assert.equal(view.verified, 1);
});

test("Google sign-in also works on plain email access", async () => {
  const { env } = setup("email");
  const { res } = await signIn(env, verifiedAlice);
  assert.equal(res.status, 302);
  const session = await verifyViewerSession(
    cookieValue(res.headers.get("Set-Cookie") || "", "au_art_g") || "",
    env,
  );
  assert.equal(session?.verified, true);
});

test("a workspace member of several orgs still completes a gate sign-in", async () => {
  const { env } = setup();
  const { res } = await signIn(env, {
    status: 403,
    body: {
      code: "organization_selection_required",
      pending_authentication_token: "pat",
      organizations: [{ id: "org_a" }, { id: "org_b" }],
      user: {
        id: "user_01MULTI",
        email: "multi@acme.com",
        email_verified: true,
      },
    },
  });
  assert.equal(res.status, 302);
});

test("an address Google does not vouch for falls back to the email code", async () => {
  for (const reply of [
    {
      status: 200,
      body: {
        user: { id: "user_01X", email: "x@acme.com", email_verified: false },
      },
    },
    {
      status: 403,
      body: {
        code: "email_verification_required",
        email: "x@acme.com",
        pending_authentication_token: "pat",
      },
    },
  ]) {
    const { env } = setup();
    const { res } = await signIn(env, reply);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /couldn(?:'|&#39;)t confirm this email address/);
    assert.match(html, /value="x@acme\.com"/);
    assert.equal(
      cookieValue(res.headers.get("Set-Cookie") || "", "au_art_g"),
      null,
    );
  }
});

test("a stale or mismatched callback never passes the gate", async () => {
  const { env } = setup();
  const started = await start(env);
  const stateCookie = cookieValue(
    started.headers.get("Set-Cookie") || "",
    "au_gstate",
  );
  const workos = mockWorkos(verifiedAlice);
  try {
    const wrong = await callback(env, stateCookie, "code=abc&state=forged");
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /didn(?:'|&#39;)t finish/);
    assert.ok(!(wrong.headers.get("Set-Cookie") || "").includes("au_art_g="));
    const noCookie = await callback(env, null, "code=abc&state=forged");
    assert.match(await noCookie.text(), /expired/);
    const denied = await callback(env, stateCookie, "error=access_denied");
    assert.match(await denied.text(), /didn(?:'|&#39;)t finish/);
  } finally {
    workos.restore();
  }
  assert.equal(
    workos.calls.filter((c) => c.url.includes("authenticate")).length,
    0,
  );
});

test("the allowlist still applies to Google sign-ins", async () => {
  const policy = JSON.stringify({ emails: [], domains: ["acme.com"] });
  const { env } = setup("allowlist", {}, policy);
  const { res: refused } = await signIn(env, verifiedAlice);
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /alice@gmail\.com is not allowed/);
  const { res: allowed } = await signIn(env, {
    status: 200,
    body: {
      user: { id: "user_01BOB", email: "bob@acme.com", email_verified: true },
    },
  });
  assert.equal(allowed.status, 302);
});

test("a signed-in Google viewer gets one-click Continue as on other gates, never via fetch()", async () => {
  const { env } = setup();
  const identity = await viewerIdentityCookie(
    env,
    "alice@gmail.com",
    "user_01ALICE",
  );
  const cookie = identity.split(";")[0];
  const page = await gatePage(env, "g2-abc123", { Cookie: cookie });
  assert.match(page, /Continue as alice@gmail\.com/);
  assert.match(page, /Not you\? Sign out/);
  const fetched = await gatePage(env, "g2-abc123", {
    Cookie: cookie,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  });
  assert.doesNotMatch(fetched, /alice@gmail\.com/);
});

test("Continue as with a Google identity mints a verified session and renews the identity", async () => {
  const { env } = setup();
  const identity = (
    await viewerIdentityCookie(env, "alice@gmail.com", "user_01ALICE")
  ).split(";")[0];
  const res = await handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/session`, {
      method: "POST",
      headers: navigationHeaders({
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${ORIGIN}/go/g2-abc123/`,
        Cookie: identity,
      }),
      body: new URLSearchParams({
        artifact_key: "g2-abc123",
        redirect_to: "/go/g2-abc123/",
      }),
    }),
    env,
    "/_au/gate/session",
  );
  assert.equal(res.status, 302);
  const setCookie = res.headers.get("Set-Cookie") || "";
  const session = await verifyViewerSession(
    cookieValue(setCookie, "au_art_g2") || "",
    env,
  );
  assert.equal(session?.email, "alice@gmail.com");
  assert.equal(session?.verified, true);
  assert.ok(cookieValue(setCookie, "au_vid"), "identity renewed");
});

test("a Google identity is never a workspace credential or a viewer session", async () => {
  const { env } = setup();
  const identity = (
    await viewerIdentityCookie(env, "member@example.com", "user_01MEMBER")
  ).split(";")[0];
  // Not a session for the comments route on its own.
  const res = await handleComments(
    new Request(`${ORIGIN}/_au/comments?artifact_key=g-abc123`, {
      headers: { Cookie: identity, Referer: `${ORIGIN}/go/g-abc123/` },
    }),
    env,
    "/_au/comments",
  );
  assert.equal(res.status, 401);
  // A viewer-session token in the identity cookie does not read as one.
  const viewer = await signPayload(
    {
      artifact_id: "art_g",
      version_id: "ver_1",
      email: "alice@gmail.com",
      verified: true,
      view_id: 1,
      exp: nowSec() + 600,
    },
    env,
  );
  const page = await gatePage(env, "g2-abc123", {
    Cookie: `au_vid=${encodeURIComponent(viewer)}`,
  });
  assert.doesNotMatch(page, /Continue as/);
});

test("sign out forgets the Google identity", async () => {
  const { env } = setup();
  const res = await handleGateRoute(
    new Request(`${ORIGIN}/_au/gate/signout`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        artifact_key: "g-abc123",
        redirect_to: "/go/g-abc123/",
      }),
    }),
    env,
    "/_au/gate/signout",
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/go/g-abc123/");
  assert.match(
    res.headers.get("Set-Cookie") || "",
    /au_vid=; Path=\/; Max-Age=0/,
  );
});
