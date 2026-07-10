import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/types.ts";
import * as prompts from "../src/llms.ts";

const env = {
  SITE_BASE_URL: "https://artifacts.example.com/",
} as Env;

const token = "au_creator_test-token-sentinel";
const expiresAt = Date.parse("2026-08-08T08:27:49.000Z") / 1000;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("agent setup delegates one harness-specific path to llms.txt", () => {
  const prompt = prompts.agentSetupPrompt(env, token, expiresAt);

  assert.match(prompt, /https:\/\/artifacts\.example\.com\/llms\.txt/);
  assert.match(prompt, /current (client|harness)/i);
  assert.match(prompt, /exactly one/i);
  assert.equal(occurrences(prompt, token), 1);
  assert.doesNotMatch(prompt, /codex mcp|claude mcp|Streamable HTTP/);
  assert.doesNotMatch(prompt, /ARTIFACT_USE_TOKEN|Authorization: Bearer/);
  assert.doesNotMatch(prompt, /ARTIFACT_USE_API_BASE/);
  assert.doesNotMatch(prompt, /\/api\/v1\//);
  assert.doesNotMatch(prompt, /CLI instead|HTTP API/);
  assert.ok(prompt.split("\n").length <= 8, "prompt should stay compact");
});

test("llms.txt makes URL-only OAuth the shared Codex default", async () => {
  const prompt = await prompts.llmsTxt(env).text();
  assert.match(
    prompt,
    /codex mcp add artifact-use --url https:\/\/artifacts\.example\.com\/mcp(?:\s|`)/,
  );
  assert.match(prompt, /codex mcp login artifact-use/);
  assert.match(prompt, /remove.*bearer_token_env_var/is);
  assert.match(prompt, /desktop.*CLI.*IDE.*share/is);
});

test("llms.txt keeps a launch-safe Codex CLI bearer fallback", async () => {
  const prompt = await prompts.llmsTxt(env).text();
  assert.match(
    prompt,
    /codex mcp add artifact-use --url https:\/\/artifacts\.example\.com\/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN/,
  );
  assert.match(prompt, /Codex CLI/i);
  assert.match(prompt, /before (starting|launching) Codex/i);
  assert.match(prompt, /restart|relaunch/i);
});

test("llms.txt gives Codex desktop the native OAuth path", async () => {
  const prompt = await prompts.llmsTxt(env).text();
  assert.match(prompt, /Settings.*MCP servers/is);
  assert.match(prompt, /Streamable HTTP/i);
  assert.match(prompt, /https:\/\/artifacts\.example\.com\/mcp/);
  assert.match(prompt, /Restart/);
  assert.match(prompt, /Authenticate/);
});

test("llms.txt gives Claude Code URL-only MCP OAuth", async () => {
  const prompt = await prompts.llmsTxt(env).text();
  assert.match(
    prompt,
    /claude mcp add --transport http artifact-use https:\/\/artifacts\.example\.com\/mcp/,
  );
  assert.match(prompt, /\/mcp/);
  assert.match(prompt, /Authenticate/);
});
