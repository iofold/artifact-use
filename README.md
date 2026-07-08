# Artifact Use

**Turn agent output into durable, reviewable web artifacts.**

Artifact Use is an open-source artifact store for coding agents and small teams.
Agents publish HTML tools, product prototypes, PDFs, images, videos, and complete
static folders through an MCP server or CLI. Artifact Use stores the files on
Cloudflare R2, tracks versions and viewer activity in D1, serves stable links,
and adds access gates plus feedback on top.

The hosted dogfood deployment runs at:

```text
https://artifacts.iofold.com
```

## What You Can Make

Artifacts can be tiny single-file HTML tools or full folders with images,
scripts, PDFs, video, data files, and local libraries. The best artifacts tend
to follow the same pattern as durable HTML tools: no build step by default,
plain HTML/CSS/JS, URL-addressable state, localStorage for drafts and settings,
client-side parsing, canvas/SVG where useful, and assets kept beside the page
when the artifact needs more than one file.

### A Full Interactive Application

This artifact is a multi-screen claims operations console. It is still just a
static artifact: HTML, local JS modules, and bundled evidence assets served from
R2 behind one stable URL.

![Claims operations console screenshot](docs/assets/readme/claims-audit-console.png)

### Multi-File Workflows With Evidence

Folder artifacts can reference supporting PDFs, generated data modules, images,
videos, and other files without stuffing every byte into model context. Agents
can create an upload session, stream files directly to the Worker, then publish
the version atomically.

![Claim workflow screenshot](docs/assets/readme/claims-document-workflow.png)

### Review And Feedback On The Artifact Itself

Artifact Use adds a lightweight feedback layer on top of hosted artifacts.
Reviewers can leave targeted comments, reply, and mark threads resolved without
the artifact needing to implement its own collaboration backend.

![Feedback widget screenshot](docs/assets/readme/feedback-widget.png)

### Research Briefs, Tools, And Interactive Documents

Single-file artifacts are useful for research briefs, calculators, inspectors,
comparison tables, and other small tools that should survive beyond the chat
where they were generated.

![Claims data atlas screenshot](docs/assets/readme/claims-data-atlas.png)

## What Artifact Use Provides

- **Stable artifact URLs** under `/go/{artifact-slug}-{six-character-code}/`.
- **Immutable versions** with atomic current-version promotion.
- **Cloudflare-native storage** using Workers, R2, and D1.
- **Access gates**: `public`, `email`, `verified_email`, and `allowlist`.
- **Viewer attribution** through email gates and share links.
- **Feedback collection** with comments, replies, resolve/reopen, and targeted
  element selection.
- **Publisher dashboard** with artifact lists, stats, recent views, share links,
  access controls, and team invitations.
- **HTTP MCP endpoint** for OAuth-capable agents.
- **Local stdio MCP server** for agents that need to walk and publish folders
  from disk.
- **JSON-first CLI** for shell workflows and direct uploads.
- **No agent-side Cloudflare credentials**. Agents publish through Artifact Use;
  the Worker owns R2/D1 access.

## Agent Publishing Paths

Use the hosted HTTP MCP endpoint when the agent can authenticate through OAuth:

```json
{
  "mcpServers": {
    "artifact-use": {
      "type": "http",
      "url": "https://artifacts.iofold.com/mcp"
    }
  }
}
```

Codex fallback when OAuth refresh is unreliable:

1. Sign in at `https://artifacts.iofold.com/admin`.
2. In **Agent setup**, create a Codex token.
3. Store the token in the environment that launches Codex:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

4. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.artifact-use]
url = "https://artifacts.iofold.com/mcp"
bearer_token_env_var = "ARTIFACT_USE_TOKEN"
```

Then start a fresh Codex process or open a new thread.

For non-OAuth clients, local CLI usage, or the bundled stdio MCP server, use the
same environment variables:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN=<artifact-use-creator-token>
```

Publish a folder with the CLI:

```bash
npm run cli -- publish-folder --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "examples/simple-site",
  "gate_level": "email"
}'
```

The CLI walks the folder, creates a draft version, uploads every file through
service-owned HTTP endpoints, completes the version, and returns a live URL.

MCP exposes two main tools:

- `artifact_publish`: publish single HTML, small inline multi-file payloads, or
  a local `dir` when using the bundled stdio MCP.
- `artifact_manage`: list artifacts, fetch stats, update access, and create
  share links. Use the returned `url_key` for exact management calls.

For large artifacts, use the direct upload flow. The server creates a short-lived
upload session, the agent uploads bytes with `PUT`, and the final manifest flips
the version live only after every referenced file exists.

## Repository Layout

```text
apps/worker/          Cloudflare Worker, D1 schema, R2 object serving
packages/cli/         Agent-friendly CLI for publishing and admin operations
packages/mcp-server/  Local stdio MCP server for folder publishing
skills/               Portable Artifact Use skill
plugins/              Codex plugin bundle
integrations/         MCP config examples
examples/             Small static folder used for smoke tests
docs/                 API, deployment, architecture, and migration notes
```

## Local Development

```bash
npm install
npm run check
npm run worker:dev
```

Run the CLI in JSON mode:

```bash
ARTIFACT_USE_TOKEN=... npm run cli -- schema --all
```

## Self-Hosting

Artifact Use is designed to run on Cloudflare with your own resources:

1. Create a Cloudflare D1 database and R2 bucket.
2. Configure `apps/worker/wrangler.toml` for your account, domain, routes,
   D1 database, and R2 bucket.
3. Apply the D1 baseline migration.
4. Set Worker secrets for sessions, WorkOS, and optional Resend email.
5. Deploy the Worker.

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
npx wrangler d1 migrations apply artifact-use --remote
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full hosted setup, WorkOS redirect
configuration, MCP auth settings, and Cloudflare route notes.

## Open-Source Scope

The code is MIT licensed. The public repository contains the Worker, schema,
CLI, MCP server, skill, plugin bundle, and docs. Hosted-service configuration
such as WorkOS applications, Cloudflare account IDs, R2/D1 resources, Resend
keys, and production secrets remain deploy-time configuration.

Before publishing your own fork or hosted instance, replace the example routes
and WorkOS/AuthKit values in `apps/worker/wrangler.toml` and `.env` files with
your own environment values.
