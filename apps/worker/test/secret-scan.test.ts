import assert from "node:assert/strict";
import test from "node:test";
import { handlePublish, UNLISTED_NOTE } from "../src/publish.ts";
import {
  allowsSecrets,
  isTextLike,
  MAX_FINDINGS,
  scanForSecrets,
} from "../src/scan.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
} from "../src/types.ts";

// Every sample below is synthetic: the right shape and length, never a real
// credential. Assembled from parts so a repository secret scanner does not
// flag the test file itself.
const SAMPLES: Array<[kind: string, text: string]> = [
  ["aws_access_key_id", `key = "${"AKIA" + "IOSFODNN7EXAMPLE"}"`],
  [
    "aws_secret_access_key",
    `aws_secret_access_key = ${"wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY"}`,
  ],
  [
    "github_token",
    `token: ${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}`,
  ],
  [
    "openai_api_key",
    `OPENAI_API_KEY=${"sk-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12Wx34"}`,
  ],
  [
    "openai_api_key",
    `const key = "${"sk-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12Wx34"}";`,
  ],
  [
    "anthropic_api_key",
    `${"sk-ant-" + "api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"}`,
  ],
  [
    "slack_token",
    `${"xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"}`,
  ],
  ["stripe_live_key", `${"rk_live_" + "Ab12Cd34Ef56Gh78Ij90Kl12"}`],
  ["stripe_or_workos_secret_key", `${"sk_live_" + "Ab12Cd34Ef56Gh78Ij90Kl12"}`],
  ["stripe_or_workos_secret_key", `${"sk_test_" + "Ab12Cd34Ef56Gh78Ij90Kl12"}`],
  ["google_api_key", `${"AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"}`],
  [
    "private_key",
    `-----BEGIN ${"RSA "}PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----`,
  ],
  ["private_key", `-----BEGIN ${"OPENSSH "}PRIVATE KEY-----`],
  ["private_key", `-----BEGIN ${""}PRIVATE KEY-----`],
  [
    "jwt",
    `${"eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}.${"eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0"}.${"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}`,
  ],
  [
    "artifact_use_creator_token",
    `${"au_creator_" + "eyJ0eXAiOiJjcmVhdG9yIiwic3ViIjoidXNlcl8xMjMifQ"}.${"3f9c1a2b4d5e6f70819a2b3c4d5e6f7081"}`,
  ],
  [
    "client_secret_assignment",
    `client_secret = "${"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"}"`,
  ],
  [
    "client_secret_assignment",
    `"clientSecret": "${"GOCSPX-a1B2c3D4e5F6g7H8i9J0k1L2"}"`,
  ],
  [
    "client_secret_assignment",
    `API_SECRET=${"9f8e7d6c5b4a39281706f5e4d3c2b1a0"}`,
  ],
];

test("each secret pattern is detected with a masked preview and a line number", () => {
  for (const [kind, text] of SAMPLES) {
    const findings = scanForSecrets(`<pre>\n\n${text}\n</pre>`, "index.html");
    assert.equal(findings.length, 1, `${kind}: ${JSON.stringify(text)}`);
    const finding = findings[0]!;
    assert.equal(finding.kind, kind);
    assert.equal(finding.path, "index.html");
    assert.equal(finding.line, 3);
    assert.match(finding.preview, /^.{4}…$/);
    // the preview never carries enough of the secret to use it
    assert.ok(finding.preview.length < 8);
  }
});

test("findings report the line of each match", () => {
  const text = [
    "<html>",
    `<p>${"AKIA" + "IOSFODNN7EXAMPLE"}</p>`,
    "<p>fine</p>",
    `<script>const t = "${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}";</script>`,
  ].join("\n");
  assert.deepEqual(
    scanForSecrets(text, "page.html").map((f) => [f.kind, f.line]),
    [
      ["aws_access_key_id", 2],
      ["github_token", 4],
    ],
  );
});

test("ordinary HTML with base64 images, UUIDs, hashes, and CSS is clean", () => {
  const base64 = Buffer.from(
    Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256),
  ).toString("base64");
  const html = `<!doctype html>
<html><head>
<meta name="description" content="Dashboard for task-manager and risk-review">
<style>.sk-fading-circle-large-loader .sk-circle-child-element { color: #AKIAFF; }</style>
</head><body>
<img src="data:image/png;base64,${base64}">
<p id="550e8400-e29b-41d4-a716-446655440000">sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855</p>
<a href="https://example.com/sk-tools/docs?token=xyz">docs</a>
<script>
  const config = { client_secret: "YOUR_CLIENT_SECRET_GOES_HERE_1234", api_secret: "<paste your api secret here>" };
  const secretKey = "\${process.env.SECRET_KEY_FROM_ENVIRONMENT}";
  const otherSecret = "example-secret-for-the-readme-only-1";
  const ghost = "ghp_short";
  const jwtDocs = "header.payload.signature has three parts";
</script>
</body></html>`;
  assert.deepEqual(scanForSecrets(html, "index.html"), []);
});

test("overlapping matches collapse to one finding and results are capped", () => {
  const nested = `client_secret = "${"sk_live_" + "Ab12Cd34Ef56Gh78Ij90Kl12"}"`;
  assert.equal(scanForSecrets(nested, "x.js").length, 1);

  const many = Array.from(
    { length: MAX_FINDINGS + 5 },
    (_, i) => `AKIA${String(i).padStart(4, "0")}ABCDEFGHIJKL`,
  ).join("\n");
  const findings = scanForSecrets(many, "keys.txt");
  assert.equal(findings.length, MAX_FINDINGS);
  assert.equal(scanForSecrets(many, "keys.txt", 3).length, 3);
  assert.equal(scanForSecrets(many, "keys.txt", 0).length, 0);
});

test("text-like detection uses the content type first, then the extension", () => {
  assert.equal(isTextLike("text/html; charset=utf-8", "index.html"), true);
  assert.equal(isTextLike("application/javascript", "app.js"), true);
  assert.equal(isTextLike("application/octet-stream", "bundle.js"), true);
  assert.equal(isTextLike("application/octet-stream", "notes.md"), true);
  assert.equal(isTextLike("image/svg+xml", "logo.svg"), true);
  assert.equal(isTextLike("image/png", "logo.png"), false);
  assert.equal(isTextLike("font/woff2", "font.woff2"), false);
  assert.equal(isTextLike("application/octet-stream", "data.bin"), false);
});

test("allow_secrets must be an explicit true", () => {
  assert.equal(allowsSecrets({ allow_secrets: true }), true);
  assert.equal(allowsSecrets({ allow_secrets: "true" }), true);
  assert.equal(allowsSecrets({ allow_secrets: 1 }), false);
  assert.equal(allowsSecrets({ allow_secrets: "yes" }), false);
  assert.equal(allowsSecrets({}), false);
  assert.equal(allowsSecrets(null), false);
});

// --- handler integration ---------------------------------------------------

const LEAKY_HTML = `<html><body><script>const k = "${"sk-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12Wx34"}";</script></body></html>`;

async function publishHtml(
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  return handlePublish(
    new Request("https://artifacts.example.com/api/v1/publish/html", {
      method: "POST",
      headers: {
        Authorization: "Bearer local-publisher-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    "/api/v1/publish/html",
  );
}

test("publish/html refuses leaked credentials before writing anything", async () => {
  const state = fakeEnv();
  const response = await publishHtml(state.env, {
    artifact: "demo",
    html: LEAKY_HTML,
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error.code, "secrets_detected");
  assert.match(body.error.message, /allow_secrets/);
  assert.equal(body.error.findings.length, 1);
  assert.equal(body.error.findings[0].kind, "openai_api_key");
  assert.equal(body.error.findings[0].path, "index.html");
  assert.equal(state.mutations, 0);
  assert.equal(state.bucketWrites, 0);
});

test("publish/html with allow_secrets publishes and reports warnings", async () => {
  const state = fakeEnv();
  const response = await publishHtml(state.env, {
    artifact: "demo",
    html: LEAKY_HTML,
    allow_secrets: true,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.url, "https://artifacts.example.com/go/demo-abc123/");
  assert.equal(body.note, UNLISTED_NOTE);
  assert.equal(body.warnings.length, 1);
  assert.equal(body.warnings[0].kind, "openai_api_key");
  assert.equal(state.bucketWrites, 1);
});

test("a clean publish/html carries the unlisted note and no warnings", async () => {
  const state = fakeEnv();
  const response = await publishHtml(state.env, {
    artifact: "demo",
    html: "<h1>hello</h1>",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.note, UNLISTED_NOTE);
  assert.equal("warnings" in body, false);
});

async function complete(
  env: Env,
  manifest: Record<string, unknown>,
): Promise<Response> {
  return handlePublish(
    new Request(
      "https://artifacts.example.com/api/v1/publish/ver_test/complete",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer local-publisher-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(manifest),
      },
    ),
    env,
    "/api/v1/publish/ver_test/complete",
  );
}

const UPLOADED: Array<ArtifactFile & { text: string }> = [
  {
    version_id: "ver_test",
    path: "index.html",
    storage_key: "k/index.html",
    content_type: "text/html; charset=utf-8",
    size: 20,
    sha256: null,
    uploaded_at: 1,
    text: "<h1>clean page</h1>",
  },
  {
    version_id: "ver_test",
    path: "app.js",
    storage_key: "k/app.js",
    content_type: "application/javascript; charset=utf-8",
    size: 60,
    sha256: null,
    uploaded_at: 1,
    text: `const token = "${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}";`,
  },
  {
    version_id: "ver_test",
    path: "logo.png",
    storage_key: "k/logo.png",
    content_type: "image/png",
    size: 1000,
    sha256: null,
    uploaded_at: 1,
    text: "AKIA" + "IOSFODNN7EXAMPLE",
  },
];

const MANIFEST = {
  entrypoint: "index.html",
  files: UPLOADED.map((f) => ({
    path: f.path,
    content_type: f.content_type,
    size: f.size,
  })),
};

test("upload completion scans text files, skips binaries, and leaves the draft intact on refusal", async () => {
  const state = fakeEnv({ uploaded: UPLOADED });
  const response = await complete(state.env, MANIFEST);
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error.code, "secrets_detected");
  assert.deepEqual(
    body.error.findings.map((f: { path: string; kind: string }) => [
      f.path,
      f.kind,
    ]),
    [["app.js", "github_token"]],
  );
  // only the two text files were read back; the PNG was never fetched
  assert.deepEqual(state.bucketGets.sort(), ["k/app.js", "k/index.html"]);
  assert.ok(state.sql.some((q) => q.includes("SET status = 'draft'")));
  assert.ok(!state.sql.some((q) => q.includes("status = 'complete'")));
});

test("upload completion with allow_secrets completes and reports warnings", async () => {
  const state = fakeEnv({ uploaded: UPLOADED });
  const response = await complete(state.env, {
    ...MANIFEST,
    allow_secrets: true,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.note, UNLISTED_NOTE);
  assert.deepEqual(
    body.warnings.map((f: { path: string }) => f.path),
    ["app.js"],
  );
  assert.ok(state.sql.some((q) => q.includes("status = 'complete'")));
});

test("upload completion without secrets completes with the note only", async () => {
  const clean = UPLOADED.filter((f) => f.path !== "app.js");
  const state = fakeEnv({ uploaded: clean });
  const response = await complete(state.env, {
    entrypoint: "index.html",
    files: clean.map((f) => ({ path: f.path, size: f.size })),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.note, UNLISTED_NOTE);
  assert.equal("warnings" in body, false);
});

// A minimal D1/R2 stand-in for the publish handlers: a new artifact with one
// draft version, no suspensions, and a bucket that serves the uploaded text.
function fakeEnv(
  options: { uploaded?: Array<ArtifactFile & { text: string }> } = {},
): {
  env: Env;
  mutations: number;
  bucketWrites: number;
  bucketGets: string[];
  sql: string[];
} {
  const artifact: Artifact = {
    id: "art_test",
    org_id: "org_test",
    slug: "demo",
    url_key: "demo-abc123",
    title: "Demo",
    description: "Already described.",
    gate_level: "public",
    allowlist_json: null,
    current_version_id: null,
    created_by: "user_test",
    created_at: 1,
    updated_at: 1,
    status: "active",
    moderation_reason: null,
    moderated_by: null,
    moderated_at: null,
    org_suspended: 0,
  };
  const version: ArtifactVersion = {
    id: "ver_test",
    artifact_id: artifact.id,
    org_id: artifact.org_id,
    status: "draft",
    entrypoint: "index.html",
    manifest_json: null,
    total_size: 0,
    file_count: 0,
    created_by: "user_test",
    created_at: 1,
    completed_at: null,
  };
  const uploaded = options.uploaded || [];
  const counters = { mutations: 0, bucketWrites: 0 };
  const bucketGets: string[] = [];
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      const statement = {
        query,
        bind(..._values: unknown[]) {
          return statement;
        },
        async first() {
          if (query.startsWith("SELECT org_id FROM org_suspensions"))
            return null;
          if (query.includes("artifact_versions")) return version;
          if (query.includes("artifact_files")) return null;
          if (query.includes("a.org_id = ? AND a.slug = ?")) return null;
          if (query.includes("url_key = ?")) return null;
          if (query.includes("FROM artifacts")) return artifact;
          return null;
        },
        async all() {
          if (query.includes("artifact_files"))
            return { results: uploaded.map(({ text: _t, ...row }) => row) };
          return { results: [] };
        },
        async run() {
          counters.mutations += 1;
          sql.push(query);
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ query: string }>) {
      counters.mutations += statements.length;
      for (const statement of statements) sql.push(statement.query);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const bucket = {
    async get(key: string) {
      bucketGets.push(key);
      const file = uploaded.find((f) => f.storage_key === key);
      if (!file) return null;
      return {
        body: new ReadableStream(),
        size: file.size,
        async text() {
          return file.text;
        },
      };
    },
    async put() {
      counters.bucketWrites += 1;
      return { size: 1 };
    },
    async delete() {},
  };
  const env = {
    DB: db,
    BUCKET: bucket,
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "scan-test-secret",
    DEV_AUTH_TOKEN: "local-publisher-token",
    DEV_AUTH_USER_ID: "user_test",
    DEV_AUTH_ORG_ID: artifact.org_id,
    DEV_AUTH_EMAIL: "publisher@example.com",
  } as unknown as Env;
  return {
    env,
    bucketGets,
    sql,
    get mutations() {
      return counters.mutations;
    },
    get bucketWrites() {
      return counters.bucketWrites;
    },
  };
}
