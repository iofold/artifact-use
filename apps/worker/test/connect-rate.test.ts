import assert from "node:assert/strict";
import test from "node:test";
import { handleConnectApi } from "../src/connect.ts";
import type { Env } from "../src/types.ts";

test("connect start limits IP before creating a pending request", async () => {
  const state = connectEnv(21);
  const response = await handleConnectApi(
    new Request("https://artifacts.example.com/api/v1/connect/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.44",
      },
      body: JSON.stringify({ agent_label: "test agent" }),
    }),
    state.env,
    "/api/v1/connect/start",
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "rate_limited");
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(state.connectWrites, 0);
  assert.equal(state.rateBuckets.length, 1);
  assert.match(state.rateBuckets[0], /^connect:start:ip:hour:/);
  assert.ok(!state.rateBuckets[0].includes("203.0.113.44"));
});

function connectEnv(count: number): {
  env: Env;
  connectWrites: number;
  rateBuckets: string[];
} {
  const state = { connectWrites: 0, rateBuckets: [] as string[] };
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("INSERT INTO rate_counters")) {
            state.rateBuckets.push(String(statement.values[0] || ""));
            return { count };
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO connect_requests"))
            state.connectWrites += 1;
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return {
    env: {
      DB: db,
      SITE_BASE_URL: "https://artifacts.example.com",
    } as unknown as Env,
    get connectWrites() {
      return state.connectWrites;
    },
    get rateBuckets() {
      return state.rateBuckets;
    },
  };
}
