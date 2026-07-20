import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/types.ts";

// The invitation journey: initiate-login context and /invite links must both
// resolve the invitation first, pin the inviting organization on the
// authorize request (no org picker), and fail politely for dead invites.

const ORG = "org_01INVITEORG000000000000000";
const TOKEN = "inv_token_abc123";

test("inviteTokenFromContext extracts the token from initiate-login context", async () => {
  const publisher = await import("../src/publisher.ts");
  assert.equal(
    publisher.inviteTokenFromContext(`invitation_token=${TOKEN}`),
    TOKEN,
  );
  assert.equal(
    publisher.inviteTokenFromContext(`foo=bar&invitation_token=${TOKEN}`),
    TOKEN,
  );
  assert.equal(
    publisher.inviteTokenFromContext("invitation_token=a%2Bb"),
    "a+b",
  );
  assert.equal(publisher.inviteTokenFromContext("foo=bar"), null);
  assert.equal(publisher.inviteTokenFromContext(null), null);
});

test("an /invite link pins the inviting org and prefers sign-in for existing accounts", async () => {
  const { publisher, restore } = await setup({
    invitation: { state: "pending", organization_id: ORG, email: "p@x.com" },
    userExists: true,
  });
  try {
    const response = await publisher.handlePublisherAuth(
      new Request(
        `https://artifacts.example/invite?invitation_token=${TOKEN}`,
      ),
      env(),
      "/invite",
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("Location") || "");
    assert.equal(location.hostname, "api.workos.com");
    assert.equal(location.searchParams.get("organization_id"), ORG);
    assert.equal(location.searchParams.get("invitation_token"), TOKEN);
    assert.equal(location.searchParams.get("screen_hint"), "sign-in");
  } finally {
    restore();
  }
});

test("initiate-login context on /login enters the same invitation journey", async () => {
  const { publisher, restore } = await setup({
    invitation: { state: "pending", organization_id: ORG, email: "p@x.com" },
    userExists: false,
  });
  try {
    const response = await publisher.handlePublisherAuth(
      new Request(
        `https://artifacts.example/login?context=invitation_token%3D${TOKEN}`,
      ),
      env(),
      "/login",
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("Location") || "");
    assert.equal(location.searchParams.get("organization_id"), ORG);
    assert.equal(location.searchParams.get("invitation_token"), TOKEN);
    assert.equal(location.searchParams.get("screen_hint"), "sign-up");
  } finally {
    restore();
  }
});

test("a dead invitation renders a friendly page instead of entering OAuth", async () => {
  const { publisher, restore } = await setup({
    invitation: { state: "revoked", organization_id: ORG, email: "p@x.com" },
    userExists: false,
  });
  try {
    const response = await publisher.handlePublisherAuth(
      new Request(
        `https://artifacts.example/invite?invitation_token=${TOKEN}`,
      ),
      env(),
      "/invite",
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /no longer valid/i);
    assert.doesNotMatch(html, /api\.workos\.com/);
  } finally {
    restore();
  }
});

function env(): Env {
  return {
    SESSION_SECRET: "invite-test-secret",
    SITE_BASE_URL: "https://artifacts.example",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "sk_test",
    WORKOS_AUTHKIT_URL: "https://auth.example",
  } as unknown as Env;
}

async function setup(opts: {
  invitation: Record<string, unknown>;
  userExists: boolean;
}): Promise<{
  publisher: typeof import("../src/publisher.ts");
  restore: () => void;
}> {
  const publisher = await import("../src/publisher.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/user_management/invitations/by_token/")) {
      return new Response(
        JSON.stringify({ id: "invitation_test", ...opts.invitation }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/user_management/users?")) {
      return new Response(
        JSON.stringify({
          data: opts.userExists ? [{ id: "user_existing" }] : [],
          list_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input as never);
  }) as typeof fetch;
  return {
    publisher,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
