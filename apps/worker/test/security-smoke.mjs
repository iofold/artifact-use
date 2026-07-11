import { signPayload } from "../src/auth.ts";

const base = (
  process.env.SECURITY_SMOKE_BASE || "http://localhost:8799"
).replace(/\/$/, "");
const secret = process.env.SESSION_SECRET;
if (!secret)
  throw new Error("SESSION_SECRET is required for the local smoke run");

let assertions = 0;

async function expect(path, expectedStatus, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method || "GET"} ${path}: expected ${expectedStatus}, got ${response.status}\n${body}`,
    );
  }
  assertions += 1;
  return { response, body };
}

function parsed(body, path) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path}: expected JSON body\n${body}`);
  }
}

function expectCode(body, code, path) {
  const actual = parsed(body, path)?.error?.code;
  if (actual !== code)
    throw new Error(`${path}: expected error code ${code}, got ${actual}`);
  assertions += 1;
}

const now = Math.floor(Date.now() / 1000);
const rawSession = await signPayload(
  {
    typ: "publisher",
    sub: "user_security_smoke",
    orgId: "org_security_smoke",
    email: "security-smoke@example.com",
    name: "Security smoke",
    role: "admin",
    roles: ["admin"],
    permissions: ["artifacts:admin"],
    exp: now + 3600,
  },
  { SESSION_SECRET: secret },
);
const sessionCookie = `au_pub=${encodeURIComponent(rawSession)}`;
const jsonHeaders = {
  Accept: "application/json",
  Cookie: sessionCookie,
  "Content-Type": "application/json",
};

await expect("/health", 200);

const retired = await expect("/api/admin/overview", 410, {
  headers: { Accept: "application/json" },
});
expectCode(retired.body, "admin_api_retired", "/api/admin/overview");

const shell = await expect("/admin/connect", 200, {
  headers: { Accept: "text/html", Cookie: sessionCookie },
});
const csrfSetCookie = shell.response.headers
  .getSetCookie()
  .find((value) => value.startsWith("au_admin_csrf="));
if (!csrfSetCookie)
  throw new Error("GET /admin/connect: missing au_admin_csrf Set-Cookie");
const csrfToken = decodeURIComponent(
  /^au_admin_csrf=([^;]+)/.exec(csrfSetCookie)?.[1] || "",
);
if (!csrfToken) throw new Error("GET /admin/connect: empty CSRF token");
if (shell.body.includes(csrfToken))
  throw new Error("GET /admin/connect: CSRF token leaked into HTML");
assertions += 3;

for (const [path, init] of [
  ["/admin/api/overview", { headers: jsonHeaders }],
  [
    "/admin/api/agent-prompt",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ label: "blocked smoke prompt" }),
    },
  ],
  [
    "/admin/artifact/access",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: sessionCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "artifact_key=missing&gate_level=public",
    },
  ],
]) {
  const blocked = await expect(path, 403, init);
  expectCode(blocked.body, "csrf_failed", path);
}

const started = await expect("/api/v1/connect/start", 200, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agent_label: "security smoke agent" }),
});
const connect = parsed(started.body, "/api/v1/connect/start");
if (!connect.verification_url?.includes("/admin/connect?code="))
  throw new Error(
    `/api/v1/connect/start: unsafe verification_url ${connect.verification_url}`,
  );
assertions += 1;

const legacy = await expect("/connect", 405, {
  method: "POST",
  headers: {
    Accept: "application/json",
    Cookie: sessionCookie,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: `code=${encodeURIComponent(connect.user_code)}`,
});
expectCode(legacy.body, "method_not_allowed", "/connect");

const blockedApproval = await expect("/admin/api/connect/approve", 403, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ code: connect.user_code }),
});
expectCode(blockedApproval.body, "csrf_failed", "/admin/api/connect/approve");

const stillPending = await expect("/api/v1/connect/poll", 200, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ device_code: connect.device_code }),
});
if (parsed(stillPending.body, "/api/v1/connect/poll").status !== "pending")
  throw new Error("blocked device approval changed the pending request");
assertions += 1;

const protectedHeaders = {
  ...jsonHeaders,
  Cookie: `${sessionCookie}; au_admin_csrf=${encodeURIComponent(csrfToken)}`,
  "X-CSRF-Token": csrfToken,
};
await expect("/admin/api/connect/approve", 200, {
  method: "POST",
  headers: protectedHeaders,
  body: JSON.stringify({ code: connect.user_code }),
});
const claimed = await expect("/api/v1/connect/poll", 200, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ device_code: connect.device_code }),
});
const claimedBody = parsed(claimed.body, "/api/v1/connect/poll");
if (claimedBody.status !== "approved" || !claimedBody.token)
  throw new Error("protected device approval did not deliver a token");
assertions += 1;

console.log(`security smoke passed (${assertions} assertions against ${base})`);
