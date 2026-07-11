import { signCreatorToken, signPayload } from "../src/auth.ts";

const base = (
  process.env.SECURITY_SMOKE_BASE || "http://localhost:8799"
).replace(/\/$/, "");
const secret = process.env.SESSION_SECRET;
if (!secret)
  throw new Error("SESSION_SECRET is required for the local smoke run");
const publisherUserId =
  process.env.SECURITY_SMOKE_PUBLISHER_USER_ID || "user_security_smoke";
const publisherOrgId =
  process.env.SECURITY_SMOKE_PUBLISHER_ORG_ID || "org_security_smoke";

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
    sub: publisherUserId,
    orgId: publisherOrgId,
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

const moderationArtifactId = process.env.SECURITY_SMOKE_MODERATION_ARTIFACT_ID;
const moderationArtifactKey =
  process.env.SECURITY_SMOKE_MODERATION_ARTIFACT_KEY;
const moderationOrgId = process.env.SECURITY_SMOKE_MODERATION_ORG_ID;
if (moderationArtifactId || moderationArtifactKey || moderationOrgId) {
  if (!moderationArtifactId || !moderationArtifactKey || !moderationOrgId)
    throw new Error(
      "moderation smoke requires SECURITY_SMOKE_MODERATION_ARTIFACT_ID, _ARTIFACT_KEY, and _ORG_ID together",
    );
  await moderationSmoke({
    artifactId: moderationArtifactId,
    artifactKey: moderationArtifactKey,
    orgId: moderationOrgId,
    otherArtifactKey: process.env.SECURITY_SMOKE_OTHER_ORG_ARTIFACT_KEY || null,
  });
}

console.log(`security smoke passed (${assertions} assertions against ${base})`);

async function moderationSmoke({
  artifactId,
  artifactKey,
  orgId,
  otherArtifactKey,
}) {
  const marker = `security smoke ${Date.now()}`;
  const publicPath = `/go/${encodeURIComponent(artifactKey)}/`;
  const before = await fetch(`${base}${publicPath}`, {
    headers: { Accept: "application/json" },
  });
  if (before.status === 410)
    throw new Error(`${publicPath}: fixture is already suspended`);
  assertions += 1;

  let artifactSuspended = false;
  try {
    await adminForm("/admin/super/artifact/suspend", {
      artifact_id: artifactId,
      reason: `${marker} artifact`,
    });
    artifactSuspended = true;
    const ownerOverview = await expect("/admin/api/overview", 200, {
      headers: protectedHeaders,
    });
    const ownerBody = parsed(ownerOverview.body, "/admin/api/overview");
    const ownerArtifact = ownerBody.artifacts?.find(
      (candidate) => candidate.id === artifactId,
    );
    if (!ownerArtifact || ownerArtifact.status !== "suspended")
      throw new Error("owner overview is missing suspended status");
    if (
      ownerOverview.body.includes(marker) ||
      Object.hasOwn(ownerArtifact, "moderation_reason")
    )
      throw new Error("owner overview leaked the private moderation reason");
    assertions += 2;
    for (const [path, init] of [
      [publicPath, { headers: { Accept: "application/json" } }],
      [
        `${publicPath}_au/index.json`,
        { headers: { Accept: "application/json" } },
      ],
      [
        `/_au/comments?artifact_key=${encodeURIComponent(artifactKey)}`,
        { headers: { Accept: "application/json" } },
      ],
      [
        "/_au/agent-token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ artifact_key: artifactKey }),
        },
      ],
      [
        "/_au/gate/email",
        {
          method: "POST",
          headers: { Accept: "application/json" },
          body: new URLSearchParams({
            artifact_key: artifactKey,
            email: "security-smoke@example.com",
          }),
        },
      ],
      [
        "/_au/gate/start",
        {
          method: "POST",
          headers: { Accept: "application/json" },
          body: new URLSearchParams({
            artifact_key: artifactKey,
            email: "security-smoke@example.com",
          }),
        },
      ],
    ]) {
      const blocked = await expect(path, 410, init);
      expectCode(blocked.body, "artifact_unavailable", path);
    }
    const browser = await expect(publicPath, 410, {
      headers: { Accept: "text/html" },
    });
    if (
      !browser.body.includes("Artifact unavailable") ||
      browser.body.includes(marker)
    )
      throw new Error(`${publicPath}: unsafe browser suspension response`);
    assertions += 1;
  } finally {
    if (artifactSuspended)
      await adminForm("/admin/super/artifact/restore", {
        artifact_id: artifactId,
      });
  }
  const artifactRestored = await fetch(`${base}${publicPath}`, {
    headers: { Accept: "application/json" },
  });
  if (artifactRestored.status === 410)
    throw new Error(`${publicPath}: artifact restore failed`);
  assertions += 1;

  let orgSuspended = false;
  try {
    await adminForm("/admin/super/org/suspend", {
      org_id: orgId,
      reason: `${marker} org`,
    });
    orgSuspended = true;
    const blocked = await expect(publicPath, 410, {
      headers: { Accept: "application/json" },
    });
    expectCode(blocked.body, "artifact_unavailable", publicPath);
    if (otherArtifactKey) {
      const other = await fetch(
        `${base}/go/${encodeURIComponent(otherArtifactKey)}/`,
        { headers: { Accept: "application/json" } },
      );
      if (other.status === 410)
        throw new Error("organization suspension leaked into another org");
      assertions += 1;
    }
    const creator = await signCreatorToken(
      {
        typ: "creator",
        sub: publisherUserId,
        org_id: orgId,
        email: "security-smoke@example.com",
        permissions: ["artifacts:publish"],
        iat: now,
        exp: now + 600,
      },
      { SESSION_SECRET: secret },
    );
    const publish = await expect("/api/v1/publish/start", 410, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${creator}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ artifact: "security-smoke-blocked" }),
    });
    expectCode(publish.body, "organization_suspended", "/api/v1/publish/start");
  } finally {
    if (orgSuspended)
      await adminForm("/admin/super/org/restore", { org_id: orgId });
  }
  const orgRestored = await fetch(`${base}${publicPath}`, {
    headers: { Accept: "application/json" },
  });
  if (orgRestored.status === 410)
    throw new Error(`${publicPath}: organization restore failed`);
  assertions += 1;

  const overview = await expect("/admin/api/super", 200, {
    headers: protectedHeaders,
  });
  const actions = parsed(overview.body, "/admin/api/super").moderationEvents;
  for (const [scope, action] of [
    ["artifact", "suspend"],
    ["artifact", "restore"],
    ["org", "suspend"],
    ["org", "restore"],
  ]) {
    if (
      !actions.some(
        (event) =>
          event.scope === scope &&
          event.action === action &&
          (action === "restore" || event.reason?.startsWith(marker)),
      )
    )
      throw new Error(`moderation audit missing ${scope} ${action}`);
    assertions += 1;
  }
}

async function adminForm(path, fields) {
  await expect(path, 302, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Cookie: protectedHeaders.Cookie,
      "X-CSRF-Token": protectedHeaders["X-CSRF-Token"],
    },
    body: new URLSearchParams(fields),
  });
}
