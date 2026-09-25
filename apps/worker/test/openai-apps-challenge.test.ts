import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

// OpenAI's app directory verifies MCP domain ownership by fetching
// /.well-known/openai-apps-challenge and expecting exactly the token string.

const base = {
  SITE_BASE_URL: "https://artifacts.example.com",
  SESSION_SECRET: "challenge-secret",
  WORKOS_AUTHKIT_URL: "https://auth.example.com",
} as unknown as Env;

test("the challenge route serves the configured token as plain text, byte for byte", async () => {
  const response = await worker.fetch(
    new Request(
      "https://artifacts.example.com/.well-known/openai-apps-challenge",
    ),
    { ...base, OPENAI_APPS_CHALLENGE_TOKEN: "a1b2c3d4-verify-me" } as Env,
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
  assert.equal(await response.text(), "a1b2c3d4-verify-me");
});

test("the challenge route is a 404 until a token is configured", async () => {
  for (const env of [base, { ...base, OPENAI_APPS_CHALLENGE_TOKEN: "  " }]) {
    const response = await worker.fetch(
      new Request(
        "https://artifacts.example.com/.well-known/openai-apps-challenge",
      ),
      env as Env,
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
  }
});

test("the challenge route only answers GET and HEAD", async () => {
  const response = await worker.fetch(
    new Request(
      "https://artifacts.example.com/.well-known/openai-apps-challenge",
      { method: "POST" },
    ),
    { ...base, OPENAI_APPS_CHALLENGE_TOKEN: "a1b2c3d4-verify-me" } as Env,
  );
  assert.equal(response.status, 405);
});
