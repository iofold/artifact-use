import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactManageTool,
  artifactPublishTool,
  artifactUploadSessionTool,
} from "@artifact-use/client-core/schemas";
import { handleMcp } from "../src/mcp.ts";
import {
  ARTIFACT_FAVICON_SVG,
  artifactPreviewImageUrl,
  extractArtifactDescription,
  handleArtifactPreviewAsset,
  injectArtifactMetadata,
  isLinkPreviewRequest,
  renderPreviewCardHtml,
} from "../src/preview.ts";
import { servePublic } from "../src/serve.ts";
import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
  Env,
} from "../src/types.ts";

const artifact = {
  id: "art_preview",
  org_id: "org_preview",
  slug: "launch-brief",
  url_key: "launch-brief-a1b2c3",
  title: "Launch brief & next steps",
  description:
    "A concise rollout brief covering milestones, owners, and launch risks.",
  gate_level: "verified_email",
  allowlist_json: null,
  current_version_id: "ver_preview",
  created_by: "user_preview",
  created_at: 1,
  updated_at: 42,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
} satisfies Artifact;

const version = {
  id: "ver_preview",
  artifact_id: artifact.id,
  org_id: artifact.org_id,
  status: "complete",
  entrypoint: "index.html",
  manifest_json: JSON.stringify({ entrypoint: "index.html", files: [] }),
  total_size: 32,
  file_count: 1,
  created_by: artifact.created_by,
  created_at: 1,
  completed_at: 2,
} satisfies ArtifactVersion;

const htmlFile = {
  version_id: version.id,
  path: "index.html",
  storage_key: "artifact/index.html",
  content_type: "text/html; charset=utf-8",
  size: 32,
  sha256: null,
  uploaded_at: 1,
} satisfies ArtifactFile;

test("extractArtifactDescription prefers authored metadata and has a readable fallback", () => {
  assert.equal(
    extractArtifactDescription(`<!doctype html><html><head>
      <meta property="og:description" content="  A &amp; B launch plan. ">
      <meta name="description" content="Ignored second choice">
    </head><body><p>Ignored body.</p></body></html>`),
    "A & B launch plan.",
  );
  assert.equal(
    extractArtifactDescription(
      `<main><h1>Title</h1><p> A practical <strong>review</strong> of&nbsp;the Q3 plan. </p></main>`,
    ),
    "A practical review of the Q3 plan.",
  );
  assert.equal(
    extractArtifactDescription("<main><h1>Only a title</h1></main>"),
    null,
  );
  assert.ok(
    (extractArtifactDescription(`<p>${"word ".repeat(80)}</p>`) || "").length <=
      200,
  );
});

test("artifact metadata is complete, escaped, canonical, and injected at the start of head", () => {
  const env = baseEnv();
  const hostile = {
    ...artifact,
    title: `Quarterly <script>alert("x")</script>`,
    description: `Private-safe summary with "quotes" & context.`,
  };
  const source = `<!doctype html><html><head><style>body{color:red}</style></head><body>ok</body></html>`;
  const output = injectArtifactMetadata(source, env, hostile, "text/html");
  const imageUrl = artifactPreviewImageUrl(env, hostile);

  assert.match(output, /<head><meta property="og:type" content="website">/);
  assert.match(output, /property="og:title"/);
  assert.match(output, /property="og:description"/);
  assert.match(output, /property="og:image:width" content="1200"/);
  assert.match(output, /property="og:image:height" content="630"/);
  assert.match(output, /name="twitter:card" content="summary_large_image"/);
  assert.match(output, /rel="icon"[^>]+_au\/artifact-icon\.svg/);
  assert.ok(output.includes(imageUrl.replaceAll("&", "&amp;")));
  assert.ok(output.indexOf('property="og:title"') < output.indexOf("<style>"));
  assert.doesNotMatch(output, /<script>alert/);
  assert.match(output, /Quarterly &lt;script&gt;alert/);
  assert.match(
    output,
    /property="og:url" content="https:\/\/artifacts\.example\.com\/go\/launch-brief-a1b2c3\/"/,
  );
});

test("preview card and favicon use the Artifact Use visual language", () => {
  const card = renderPreviewCardHtml(baseEnv(), artifact, "text/html");
  assert.match(card, /width:\s*1200px/);
  assert.match(card, /height:\s*630px/);
  assert.match(card, /ARTIFACT USE/);
  assert.match(card, /Launch brief &amp; next steps/);
  assert.match(card, /A concise rollout brief/);
  assert.match(card, /VERIFIED EMAIL/);
  assert.match(card, /INTERACTIVE/);
  assert.match(card, /#d8ff4a/i);
  assert.doesNotMatch(card, /recipient|share-secret|viewer@example\.com/i);

  assert.match(ARTIFACT_FAVICON_SVG, /^<svg[^>]+viewBox="0 0 64 64"/);
  assert.match(ARTIFACT_FAVICON_SVG, /#d8ff4a/i);
  assert.match(ARTIFACT_FAVICON_SVG, /<path/);
});

test("preview card compacts long deployment hosts without an accidental ellipsis", () => {
  const card = renderPreviewCardHtml(
    {
      ...baseEnv(),
      SITE_BASE_URL: "https://artifact-use-staging.example.workers.dev",
    },
    artifact,
    "text/html",
  );
  assert.match(card, /artifact-use-staging · workers\.dev/);
  assert.doesNotMatch(card, /artifact-use-staging\.yashg2\.workers\.dev/);
});

test("link-preview clients are detected without treating normal browsers as crawlers", () => {
  for (const userAgent of [
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Twitterbot/1.0",
    "facebookexternalhit/1.1",
    "WhatsApp/2.23",
    "LinkedInBot/1.0",
    "Discordbot/2.0",
  ]) {
    assert.equal(
      isLinkPreviewRequest(
        new Request("https://artifacts.example.com/go/x/", {
          headers: { "User-Agent": userAgent },
        }),
      ),
      true,
      userAgent,
    );
  }
  assert.equal(
    isLinkPreviewRequest(
      new Request("https://artifacts.example.com/go/x/", {
        headers: {
          Accept: "text/html",
          "User-Agent":
            "Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
      }),
    ),
    false,
  );
});

test("gated crawler response is a 200 preview envelope and never leaks tracked-share data", async () => {
  const state = servingEnv({
    artifact,
    share: { id: "share-secret", recipient_email: "viewer@example.com" },
  });
  const response = await servePublic(
    new Request(
      "https://artifacts.example.com/go/launch-brief-a1b2c3/?v=share-secret",
      { headers: { "User-Agent": "Slackbot-LinkExpanding 1.0" } },
    ),
    state.env,
    "/go/launch-brief-a1b2c3/",
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  assert.match(body, /property="og:image"/);
  assert.match(body, /Launch brief &amp; next steps/);
  assert.doesNotMatch(body, /viewer@example\.com|share-secret/);
  assert.equal(state.bucketReads, 0);
});

test("explicit JSON clients still receive the machine-readable 401 gate", async () => {
  const state = servingEnv({ artifact });
  const response = await servePublic(
    new Request("https://artifacts.example.com/go/launch-brief-a1b2c3/", {
      headers: { Accept: "application/json" },
    }),
    state.env,
    "/go/launch-brief-a1b2c3/",
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  assert.equal((await response.json()).error.code, "gate_required");
});

test("public non-HTML artifacts give known crawlers metadata rather than file bytes", async () => {
  const pdfVersion = { ...version, entrypoint: "brief.pdf" };
  const pdfFile = {
    ...htmlFile,
    path: "brief.pdf",
    storage_key: "artifact/brief.pdf",
    content_type: "application/pdf",
  };
  const state = servingEnv({
    artifact: { ...artifact, gate_level: "public" },
    version: pdfVersion,
    file: pdfFile,
  });
  const response = await servePublic(
    new Request("https://artifacts.example.com/go/launch-brief-a1b2c3/", {
      headers: { "User-Agent": "Twitterbot/1.0" },
    }),
    state.env,
    "/go/launch-brief-a1b2c3/",
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/);
  assert.match(body, /property="og:title"/);
  assert.match(body, /PDF/);
  assert.equal(state.bucketReads, 0);
});

test("preview PNG is generated once through Browser Rendering and stored immutably", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls: Array<{ action: string; options: Record<string, unknown> }> = [];
  const writes: Array<{ key: string; bytes: Uint8Array }> = [];
  const state = servingEnv({ artifact });
  (state.env as Env).BROWSER = {
    async quickAction(action: string, options: Record<string, unknown>) {
      calls.push({ action, options });
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    },
  } as unknown as BrowserRun;
  (state.env as Env).BUCKET = {
    async get() {
      return null;
    },
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView,
    ) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(await new Response(value).arrayBuffer());
      writes.push({ key, bytes });
      return { size: bytes.byteLength };
    },
  } as unknown as R2Bucket;
  const url = artifactPreviewImageUrl(state.env, artifact);
  const response = await handleArtifactPreviewAsset(
    new Request(url),
    state.env,
    new URL(url).pathname,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.action, "screenshot");
  assert.deepEqual(calls[0]?.options.viewport, { width: 1200, height: 630 });
  assert.match(String(calls[0]?.options.html), /Launch brief &amp; next steps/);
  assert.equal(writes.length, 1);
  assert.match(writes[0]?.key || "", /^previews\/art_preview\//);
});

test("publish and MCP schemas expose public-safe summaries and editable previews", () => {
  for (const tool of [artifactPublishTool, artifactUploadSessionTool]) {
    const description = tool.inputSchema.properties.description as {
      type?: string;
      maxLength?: number;
      description?: string;
    };
    assert.equal(description.type, "string");
    assert.equal(description.maxLength, 200);
    assert.match(description.description || "", /public/i);
  }
  const action = artifactManageTool.inputSchema.properties.action as {
    enum?: string[];
  };
  assert.ok(action.enum?.includes("set_preview"));
  assert.ok("description" in artifactManageTool.inputSchema.properties);
  assert.ok("title" in artifactManageTool.inputSchema.properties);
});

test("artifact_manage set_preview updates title and summary through the HTTP adapter", async () => {
  let current = { ...artifact };
  const updates: unknown[][] = [];
  const state = servingEnv({ artifact: current });
  (state.env as Env).DB = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("FROM artifacts")) return current;
          return null;
        },
        async run() {
          if (sql.includes("UPDATE artifacts") && sql.includes("description")) {
            updates.push(statement.values);
            current = {
              ...current,
              title: String(statement.values[0]),
              description: String(statement.values[1]),
              updated_at: Number(statement.values[2]),
            };
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  const response = await handleMcp(
    new Request("https://artifacts.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "artifact_manage",
          arguments: {
            action: "set_preview",
            artifact: artifact.url_key,
            title: "Updated launch brief",
            description: "The editable public summary.",
          },
        },
      }),
    }),
    state.env,
  );
  const body = (await response.json()) as {
    result?: { structuredContent?: { artifact?: Artifact } };
    error?: unknown;
  };

  assert.equal(response.status, 200);
  assert.equal(body.error, undefined);
  assert.equal(updates.length, 1);
  assert.equal(
    body.result?.structuredContent?.artifact?.description,
    "The editable public summary.",
  );
});

function baseEnv(): Env {
  return {
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    SESSION_SECRET: "preview-test-secret",
  } as unknown as Env;
}

function servingEnv(options: {
  artifact: Artifact;
  version?: ArtifactVersion;
  file?: ArtifactFile;
  share?: { id: string; recipient_email: string };
}): { env: Env; bucketReads: number } {
  const selectedVersion = options.version || version;
  const selectedFile = options.file || htmlFile;
  let bucketReads = 0;
  const env = {
    ...baseEnv(),
    DEV_AUTH_TOKEN: "dev-token",
    DEV_AUTH_USER_ID: "user_preview",
    DEV_AUTH_ORG_ID: options.artifact.org_id,
    DEV_AUTH_EMAIL: "publisher@example.com",
    DB: {
      prepare(sql: string) {
        const statement = {
          bind(..._values: unknown[]) {
            return statement;
          },
          async first() {
            if (sql.includes("share_links")) {
              return options.share
                ? {
                    ...options.share,
                    expires_at: null,
                    revoked_at: null,
                  }
                : null;
            }
            if (sql.includes("artifact_versions")) return selectedVersion;
            if (sql.includes("artifact_files")) return selectedFile;
            if (sql.includes("artifacts")) return options.artifact;
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    },
    BUCKET: {
      async get() {
        bucketReads += 1;
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  "<!doctype html><html><head></head><body>artifact body</body></html>",
                ),
              );
              controller.close();
            },
          }),
          size: 68,
          uploaded: new Date(0),
          httpEtag: '"preview-test"',
          httpMetadata: { contentType: selectedFile.content_type },
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", selectedFile.content_type);
          },
          async text() {
            return "<!doctype html><html><head></head><body>artifact body</body></html>";
          },
        };
      },
      async head() {
        return null;
      },
      async put() {
        return { size: 1 };
      },
      async delete() {},
    },
  } as unknown as Env;
  return {
    env,
    get bucketReads() {
      return bucketReads;
    },
  };
}
