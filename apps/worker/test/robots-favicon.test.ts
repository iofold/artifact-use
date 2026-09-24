import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

const env = {
  SITE_BASE_URL: "https://artifacts.example.com",
  SESSION_SECRET: "robots-secret",
  WORKOS_AUTHKIT_URL: "https://auth.example.com",
} as unknown as Env;

test("robots.txt keeps crawlers out of operator and machine surfaces only", async () => {
  const response = await worker.fetch(
    new Request("https://artifacts.example.com/robots.txt"),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /^User-agent: \*/m);
  assert.match(body, /^Disallow: \/admin$/m);
  assert.match(body, /^Disallow: \/mcp$/m);
  // artifact pages stay fetchable so their noindex header is honored
  assert.doesNotMatch(body, /Disallow: \/go/);
});

test("favicon.ico resolves to the artifact icon", async () => {
  const response = await worker.fetch(
    new Request("https://artifacts.example.com/favicon.ico"),
    env,
  );
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("Location"),
    "https://artifacts.example.com/_au/artifact-icon.svg",
  );
});
