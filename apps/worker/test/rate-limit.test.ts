import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/types.ts";

test("D1 fixed-window limiter is atomic, hashed, and returns retry timing", async () => {
  const rl = await import("../src/rl.ts").catch(() => ({}));
  assert.equal(typeof rl.rateLimit, "function");
  assert.equal(typeof rl.hashRateKey, "function");
  assert.equal(typeof rl.rateLimitedResponse, "function");

  const state = fakeRateEnv();
  const emailHash = await rl.hashRateKey(" Person@Example.COM ");
  assert.equal(emailHash, await rl.hashRateKey("person@example.com"));
  assert.doesNotMatch(emailHash, /person|example/i);
  const bucket = `otp:start:email:${emailHash}`;
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(await rl.rateLimit(state.env, bucket, 3, 3600, 7205));
  }

  assert.deepEqual(
    results.map((result) => result.allowed),
    [true, true, true, false],
  );
  assert.equal(results[3].count, 4);
  assert.ok(results[3].retryAfter > 0 && results[3].retryAfter <= 3600);
  assert.equal(state.cleanupRuns, 1);
  assert.match(state.incrementSql, /ON CONFLICT\s*\(bucket, window_start\)/i);
  assert.match(state.incrementSql, /RETURNING count/i);

  const response = rl.rateLimitedResponse(results[3]);
  assert.equal(response.status, 429);
  assert.equal(
    response.headers.get("Retry-After"),
    String(results[3].retryAfter),
  );
  assert.equal((await response.json()).error.code, "rate_limited");
});

test("concurrent increments admit exactly the configured boundary", async () => {
  const rl = await import("../src/rl.ts").catch(() => ({}));
  assert.equal(typeof rl.rateLimit, "function");
  const state = fakeRateEnv();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      rl.rateLimit(state.env, "otp:verify:test", 6, 900, 9001),
    ),
  );

  assert.equal(results.filter((result) => result.allowed).length, 6);
  assert.equal(Math.max(...results.map((result) => result.count)), 20);
});

function fakeRateEnv(): {
  env: Env;
  cleanupRuns: number;
  incrementSql: string;
} {
  const counts = new Map<string, number>();
  const state = { cleanupRuns: 0, incrementSql: "" };
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          state.incrementSql = sql;
          const key = `${statement.values[0]}:${statement.values[1]}`;
          const count = (counts.get(key) || 0) + 1;
          counts.set(key, count);
          return { count };
        },
        async run() {
          if (sql.startsWith("DELETE FROM rate_counters"))
            state.cleanupRuns += 1;
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return {
    env: { DB: db } as unknown as Env,
    get cleanupRuns() {
      return state.cleanupRuns;
    },
    get incrementSql() {
      return state.incrementSql;
    },
  };
}
