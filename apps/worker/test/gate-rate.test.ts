import assert from "node:assert/strict";
import test from "node:test";
import { handleGateRoute } from "../src/gate.ts";
import type { Artifact, Env } from "../src/types.ts";

test("OTP start rejects public and plain-email artifacts before writes", async () => {
  for (const gateLevel of ["public", "email"] as const) {
    const state = gateEnv(gateLevel);
    const response = await startOtp(state.env);
    assert.equal(response.status, 400, gateLevel);
    assert.equal((await response.json()).error.code, "otp_not_required");
    assert.equal(state.tokenWrites.length, 0, gateLevel);
    assert.equal(state.rateIncrements, 0, gateLevel);
  }
});

test("a new OTP invalidates earlier unused codes before inserting", async () => {
  const state = gateEnv("verified_email");
  const response = await startOtp(state.env);

  assert.equal(response.status, 200);
  assert.deepEqual(
    state.tokenWrites.map((entry) => entry.kind),
    ["invalidate", "insert"],
  );
  assert.match(state.tokenWrites[0].sql, /used_at IS NULL/i);
});

test("OTP start enforces email, artifact, and IP windows before token writes", async () => {
  for (const [bucketPart, blockedCount] of [
    ["otp:start:email:hour:", 4],
    ["otp:start:email:day:", 11],
    ["otp:start:artifact:day:", 51],
    ["otp:start:ip:hour:", 21],
  ] as const) {
    const state = gateEnv("verified_email", {
      rateCount: (bucket) => (bucket.includes(bucketPart) ? blockedCount : 1),
    });
    const response = await startOtp(state.env);
    assert.equal(response.status, 429, bucketPart);
    assert.equal((await response.json()).error.code, "rate_limited");
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    assert.equal(state.tokenWrites.length, 0);
    assert.ok(state.rateBuckets.some((bucket) => bucket.includes(bucketPart)));
    assert.ok(
      state.rateBuckets.every(
        (bucket) =>
          !bucket.includes("viewer@example.com") &&
          !bucket.includes("203.0.113.9"),
      ),
    );
  }
});

test("browser gate throttles render an understandable HTML error", async () => {
  const state = gateEnv("verified_email", {
    rateCount: (bucket) => (bucket.includes("otp:start:email:hour:") ? 4 : 1),
  });
  const response = await startOtp(state.env, "Viewer@Example.com", "text/html");
  assert.equal(response.status, 429);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.match(await response.text(), /too many|try again|please wait/i);
});

test("OTP verify is unavailable to non-verified gates", async () => {
  const state = gateEnv("email");
  const response = await verifyOtp(state.env, "123456");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "otp_not_required");
  assert.equal(state.rateIncrements, 0);
});

test("OTP verify validates email and code before consuming quota", async () => {
  for (const [email, code] of [
    ["not-an-email", "123456"],
    ["viewer@example.com", ""],
  ] as const) {
    const state = gateEnv("verified_email");
    const response = await verifyOtp(state.env, code, email);
    assert.equal(response.status, 400);
    assert.equal(state.rateIncrements, 0);
    assert.equal(state.tokenReads, 0);
  }
});

test("gate endpoints reject oversized email keys before counters", async () => {
  const oversized = `${"a".repeat(310)}@example.com`;
  for (const invoke of [
    (env: Env) => startOtp(env, oversized),
    (env: Env) => verifyOtp(env, "123456", oversized),
    (env: Env) => emailGate(env, oversized),
  ]) {
    const state = gateEnv("verified_email");
    const response = await invoke(state.env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_email");
    assert.equal(state.rateIncrements, 0);
  }
});

test("OTP verify limits identity and IP guesses before token lookup", async () => {
  for (const [bucketPart, blockedCount] of [
    ["otp:verify:identity:15m:", 7],
    ["otp:verify:ip:10m:", 31],
  ] as const) {
    const state = gateEnv("verified_email", {
      rateCount: (bucket) => (bucket.includes(bucketPart) ? blockedCount : 1),
    });
    const response = await verifyOtp(state.env, "123456");
    assert.equal(response.status, 429, bucketPart);
    assert.equal((await response.json()).error.code, "rate_limited");
    assert.ok(Number(response.headers.get("Retry-After")) > 0);
    assert.equal(state.tokenReads, 0);
    assert.ok(state.rateBuckets.some((bucket) => bucket.includes(bucketPart)));
    assert.ok(
      state.rateBuckets.every(
        (bucket) =>
          !bucket.includes("viewer@example.com") &&
          !bucket.includes("203.0.113.9"),
      ),
    );
  }
});

test("successful OTP verify clears the identity failure window", async () => {
  const state = gateEnv("verified_email", { token: "vt_valid" });
  const response = await verifyOtp(state.env, "123456");
  assert.equal(response.status, 200);
  assert.equal(state.tokenReads, 1);
  assert.equal(state.rateDeletes.length, 1);
  assert.match(state.rateDeletes[0], /^otp:verify:identity:15m:/);
  assert.ok(!state.rateDeletes[0].includes("viewer@example.com"));
});

test("plain email gate limits IP session issuance", async () => {
  const state = gateEnv("email", {
    rateCount: (bucket) => (bucket.includes("gate:email:ip:hour:") ? 61 : 1),
  });
  const response = await emailGate(state.env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "rate_limited");
  assert.equal(state.viewWrites, 0);
  assert.ok(
    state.rateBuckets.some((bucket) =>
      bucket.startsWith("gate:email:ip:hour:"),
    ),
  );
  assert.ok(
    state.rateBuckets.every((bucket) => !bucket.includes("203.0.113.9")),
  );
});

async function startOtp(
  env: Env,
  email = "Viewer@Example.com",
  accept = "application/json",
): Promise<Response> {
  return handleGateRoute(
    new Request("https://artifacts.example.com/_au/gate/start", {
      method: "POST",
      headers: {
        Accept: accept,
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        email,
      }),
    }),
    env,
    "/_au/gate/start",
  );
}

async function verifyOtp(
  env: Env,
  code: string,
  email = "Viewer@Example.com",
): Promise<Response> {
  return handleGateRoute(
    new Request("https://artifacts.example.com/_au/gate/verify", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        email,
        code,
      }),
    }),
    env,
    "/_au/gate/verify",
  );
}

async function emailGate(
  env: Env,
  email = "Viewer@Example.com",
): Promise<Response> {
  return handleGateRoute(
    new Request("https://artifacts.example.com/_au/gate/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new URLSearchParams({
        artifact_key: "gate-demo-abc123",
        email,
      }),
    }),
    env,
    "/_au/gate/email",
  );
}

function gateEnv(
  gateLevel: Artifact["gate_level"],
  options: {
    rateCount?: (bucket: string) => number;
    token?: string;
  } = {},
): {
  env: Env;
  tokenWrites: Array<{ kind: "invalidate" | "insert"; sql: string }>;
  rateIncrements: number;
  rateBuckets: string[];
  rateDeletes: string[];
  tokenReads: number;
  viewWrites: number;
} {
  const artifact: Artifact = {
    id: "art_gate",
    org_id: "org_gate",
    slug: "gate-demo",
    url_key: "gate-demo-abc123",
    title: "Gate demo",
    description: null,
    gate_level: gateLevel,
    allowlist_json: null,
    current_version_id: "ver_gate",
    created_by: "user_gate",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
  const state = {
    tokenWrites: [] as Array<{
      kind: "invalidate" | "insert";
      sql: string;
    }>,
    rateIncrements: 0,
    rateBuckets: [] as string[],
    rateDeletes: [] as string[],
    tokenReads: 0,
    viewWrites: 0,
  };
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
            state.rateIncrements += 1;
            const bucket = String(statement.values[0] || "");
            state.rateBuckets.push(bucket);
            return { count: options.rateCount?.(bucket) || 1 };
          }
          if (sql.includes("FROM artifacts")) return artifact;
          if (sql.includes("SELECT token FROM viewer_tokens")) {
            state.tokenReads += 1;
            return options.token ? { token: options.token } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("DELETE FROM rate_counters WHERE bucket = ?"))
            state.rateDeletes.push(String(statement.values[0] || ""));
          if (sql.startsWith("UPDATE viewer_tokens"))
            state.tokenWrites.push({ kind: "invalidate", sql });
          if (sql.includes("INSERT INTO viewer_tokens"))
            state.tokenWrites.push({ kind: "insert", sql });
          if (sql.includes("INSERT INTO views")) state.viewWrites += 1;
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
  };
  return {
    env: {
      DB: db,
      SITE_BASE_URL: "https://artifacts.example.com",
      ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
      SESSION_SECRET: "gate-test-secret",
      ALLOW_DEBUG_CODES: "true",
    } as unknown as Env,
    get tokenWrites() {
      return state.tokenWrites;
    },
    get rateIncrements() {
      return state.rateIncrements;
    },
    get rateBuckets() {
      return state.rateBuckets;
    },
    get rateDeletes() {
      return state.rateDeletes;
    },
    get tokenReads() {
      return state.tokenReads;
    },
    get viewWrites() {
      return state.viewWrites;
    },
  };
}
