import assert from "node:assert/strict";
import test from "node:test";
import { signCreatorToken } from "../src/auth.ts";
import {
  handleMcp,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
} from "../src/mcp.ts";
import type { Env } from "../src/types.ts";
import { nowSec } from "../src/util.ts";

const ORIGIN = "https://artifacts.example.com";
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "TestClient", version: "9.9" },
};

type Recorded = { sql: string; params: unknown[] };

function fakeEnv(): { env: Env; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      const make = (params: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          recorded.push({ sql, params });
          return { meta: { changes: 1 } };
        },
      });
      return make([]);
    },
    async batch() {
      return [];
    },
  };
  const env = {
    DB: db,
    SITE_BASE_URL: ORIGIN,
    SESSION_SECRET: "mcp-transport-secret",
    WORKOS_AUTHKIT_URL: "https://auth.example.com",
    WORKOS_ISSUER: "https://auth.example.com",
    WORKOS_AUDIENCE: `${ORIGIN}/mcp`,
    WORKOS_JWKS_URL: "https://auth.example.com/oauth2/jwks",
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_01TESTUSER",
    DEV_AUTH_ORG_ID: "org_test",
  } as unknown as Env;
  return { env, recorded };
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  token = "dev-token",
): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "codex-mcp-client/0.156.1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const modernHeaders = (method: string, name?: string) => ({
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": method,
  ...(name ? { "Mcp-Name": name } : {}),
});

test("GET and DELETE are 405 before authentication: no stream, no sessions", async () => {
  const { env } = fakeEnv();
  for (const method of ["GET", "DELETE"]) {
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, { method }),
      env,
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
  }
});

test("an unauthenticated POST is 401 and still recorded as an event", async () => {
  const { env, recorded } = fakeEnv();
  const response = await handleMcp(
    post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {}, ""),
    env,
  );
  assert.equal(response.status, 401);
  const event = recorded.find((r) => r.sql.includes("INSERT INTO mcp_events"));
  assert.ok(event, "event row");
  // client is derived from the User-Agent, auth_kind is none, ok is 0
  assert.equal(event.params[6], "codex");
  assert.equal(event.params[5], "none");
  assert.equal(event.params[13], 0);
  assert.equal(event.params[15], "unauthorized");
});

test("an expired creator token is a distinct token_expired 401 with a renew url", async () => {
  const { env } = fakeEnv();
  const now = nowSec();
  const expired = await signCreatorToken(
    {
      typ: "creator",
      jti: "crt_expired",
      sub: "user_01TESTUSER",
      org_id: "org_test",
      email: null,
      permissions: ["artifacts:publish"],
      iat: now - 200,
      exp: now - 100,
    },
    env,
  );
  const response = await handleMcp(
    post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {},
      expired,
    ),
    env,
  );
  assert.equal(response.status, 401);
  const body = (await response.json()) as {
    error: { code: string; renew_url?: string };
  };
  assert.equal(body.error.code, "token_expired");
  assert.equal(body.error.renew_url, `${ORIGIN}/admin/connect`);
  assert.match(response.headers.get("WWW-Authenticate") || "", /invalid_token/);
});

test("legacy initialize negotiates a legacy version and never adds resultType", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: { protocolVersion: string; resultType?: string };
  };
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.resultType, undefined);
  assert.ok(LEGACY_PROTOCOL_VERSIONS.includes(body.result.protocolVersion));
});

test("a legacy notification gets 202 with no body", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    env,
  );
  assert.equal(response.status, 202);
});

test("server/discover advertises the modern version, tools, and server identity", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post(
      {
        jsonrpc: "2.0",
        id: "d1",
        method: "server/discover",
        params: { _meta: META },
      },
      modernHeaders("server/discover"),
    ),
    env,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: Record<string, unknown> & { _meta: Record<string, unknown> };
  };
  assert.equal(body.result.resultType, "complete");
  assert.deepEqual(body.result.supportedVersions, MODERN_PROTOCOL_VERSIONS);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(
    (
      body.result._meta["io.modelcontextprotocol/serverInfo"] as {
        name: string;
      }
    ).name,
    "artifact-use",
  );
  assert.equal(typeof body.result.ttlMs, "number");
});

test("a modern tools/list carries resultType, ttlMs, cacheScope and serverInfo", async () => {
  const { env, recorded } = fakeEnv();
  const response = await handleMcp(
    post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } },
      modernHeaders("tools/list"),
    ),
    env,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: {
      resultType: string;
      tools: Array<{ name: string }>;
      ttlMs: number;
      cacheScope: string;
      _meta: Record<string, unknown>;
    };
  };
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.tools.length, 4);
  assert.equal(body.result.cacheScope, "private");
  assert.ok(body.result.ttlMs > 0);
  const event = recorded.find((r) => r.sql.includes("INSERT INTO mcp_events"));
  // clientInfo from _meta wins over the User-Agent (normalized)
  assert.equal(event?.params[6], "testclient");
  assert.equal(event?.params[7], "9.9");
  assert.equal(event?.params[9], "2026-07-28");
});

test("a modern request without Mcp-Method is a 400 HeaderMismatch", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: META } },
      { "MCP-Protocol-Version": "2026-07-28" },
    ),
    env,
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32020);
});

test("an unsupported modern version lists the versions the server speaks", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {
          _meta: {
            ...META,
            "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          },
        },
      },
      { ...modernHeaders("tools/list"), "MCP-Protocol-Version": "2099-01-01" },
    ),
    env,
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: number; data: { supported: string[]; requested: string } };
  };
  assert.equal(body.error.code, -32022);
  assert.equal(body.error.data.requested, "2099-01-01");
  assert.ok(body.error.data.supported.includes("2026-07-28"));
  assert.ok(body.error.data.supported.includes("2025-06-18"));
});

test("a tool that fails reports isError with a structured error, and the event records it", async () => {
  const { env, recorded } = fakeEnv();
  const response = await handleMcp(
    post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "artifact_comments",
          arguments: { action: "list" },
          _meta: META,
        },
      },
      modernHeaders("tools/call", "artifact_comments"),
    ),
    env,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: {
      isError: boolean;
      resultType: string;
      structuredContent: { error: { code: string; status: number } };
    };
  };
  assert.equal(body.result.isError, true);
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.structuredContent.error.code, "invalid_arguments");
  assert.equal(body.result.structuredContent.error.status, 400);
  const event = recorded.find((r) => r.sql.includes("INSERT INTO mcp_events"));
  assert.equal(event?.params[11], "artifact_comments");
  assert.equal(event?.params[12], "list");
  assert.equal(event?.params[13], 0);
  assert.equal(event?.params[15], "invalid_arguments");
});

test("an unknown tool is a JSON-RPC invalid params error, not a tool result", async () => {
  const { env } = fakeEnv();
  const response = await handleMcp(
    post(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "nope", arguments: {}, _meta: META },
      },
      modernHeaders("tools/call", "nope"),
    ),
    env,
  );
  const body = (await response.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32602);
});

test("clientInfo names are normalized onto the User-Agent vocabulary", async () => {
  const { normalizeClientName } = await import("../src/events.ts");
  assert.equal(normalizeClientName("codex-mcp-client"), "codex");
  assert.equal(normalizeClientName("Claude Code"), "claude-code");
  assert.equal(normalizeClientName("claude-ai"), "claude-ai");
  assert.equal(
    normalizeClientName("Some Custom Client 2"),
    "some-custom-client-2",
  );
});
