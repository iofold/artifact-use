# Artifact Use

**Turn agent output into durable, reviewable web artifacts.**

[![CI](https://github.com/iofold/artifact-use/actions/workflows/ci.yml/badge.svg)](https://github.com/iofold/artifact-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Artifact Use is an open-source artifact store for coding agents and small teams.
Agents publish HTML tools, product prototypes, PDFs, images, videos, and complete
static folders through an MCP server or CLI. Artifact Use stores the files on
Cloudflare R2, tracks versions and viewer activity in D1, serves stable links,
and adds access gates plus comments on top.

The hosted dogfood deployment runs at:

```text
https://artifacts.iofold.com
```

Any agent connects in one step: install the plugin (Claude Code, Codex, or any
skills-aware harness) or paste the quick-connect prompt from `/admin/connect`.
Artifact Use never publishes unless the agent calls a publish tool: reading,
listing, stats, and comments change nothing, and a republish keeps the same
link. The agent-facing guide lives in one file,
[docs/agent-guide.md](docs/agent-guide.md), served as
[`/llms.txt`](https://artifacts.iofold.com/llms.txt) and
[`/llms-full.txt`](https://artifacts.iofold.com/llms-full.txt).

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

### Review And Comments On The Artifact Itself

Artifact Use adds a lightweight comments layer on top of hosted artifacts.
Reviewers can leave targeted comments, reply, and mark threads resolved without
the artifact needing to implement its own collaboration backend.

![Comments widget screenshot](docs/assets/readme/feedback-widget.png)

### Research Briefs, Tools, And Interactive Documents

Single-file artifacts are useful for research briefs, calculators, inspectors,
comparison tables, and other small tools that should survive beyond the chat
where they were generated.

![Claims data atlas screenshot](docs/assets/readme/claims-data-atlas.png)

The repository also includes runnable showcase artifacts under `docs/showcase/`.
Their screenshots, stills, and synthetic data are documented in
[docs/ASSET_PROVENANCE.md](docs/ASSET_PROVENANCE.md).

## What Artifact Use Provides

- **Stable artifact URLs** under `/go/{artifact-slug}-{six-character-code}/`.
- **Immutable versions** with atomic current-version promotion.
- **Lifecycle management**: move artifacts between workspaces (URL-stable) and
  permanently delete them — from the dashboard, API, or MCP.
- **Cloudflare-native storage** using Workers, R2, and D1.
- **Access gates**: `public`, `email`, `verified_email`, and `allowlist`.
- **Rich link previews** with public-safe Open Graph/X metadata, branded
  1200×630 cards, and a distinct artifact favicon—even when content is gated.
- **Viewer attribution** through email gates and share links.
- **Comments** with replies, resolve/reopen, and targeted
  element selection.
- **Publisher dashboard** with artifact lists, stats, recent views, share links,
  access controls, editable link previews, and team invitations.
- **Upstream backends**: a gated artifact can call one HTTPS backend through
  its `_api/` path; the Worker adds the stored secret and the viewer's gate
  email, so the page ships no credential.
- **Hosted HTTP MCP endpoint** (Streamable HTTP, POST only) with OAuth and
  bearer authentication, and an Agent Plugins 1.0 package at the repository
  root.
- **Local stdio MCP server** for agents that need to walk and publish folders
  from disk.
- **JSON-first CLI** for shell workflows and direct uploads.
- **No agent-side Cloudflare credentials**. Agents publish through Artifact Use;
  the Worker owns R2/D1 access.

## Connect An Agent

There are two documented ways in. Both end with the same four MCP tools, and
neither publishes anything until the agent is asked to.

### Install The Plugin

The repository root is an [Agent Plugins 1.0](https://agent-plugins.org)
package (`plugin.json`, `mcp.json`, `skills/artifact-use`), a Claude Code
plugin and marketplace, and a Codex marketplace. Each registers the hosted MCP
endpoint and the `artifact-use` skill; the harness then prompts for OAuth
sign-in.

```bash
# Claude Code
claude plugin marketplace add iofold/artifact-use
claude plugin install artifact-use@artifact-use

# Codex
codex plugin marketplace add iofold/artifact-use
codex plugin add artifact-use@artifact-use

# Any agent that reads SKILL.md (Cursor, Copilot, Windsurf, Cline, ...)
npx skills add iofold/artifact-use

# Agent Plugins 1.0 clients (Claude Code, Cursor, Codex, Copilot CLI, VS Code)
npx plugins add iofold/artifact-use
```

### Path 1: OAuth In Claude Code And Codex

No token is involved. Claude Code:

```bash
claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp
```

Then open `/mcp`, select `artifact-use`, and choose **Authenticate**.

Codex desktop, CLI, and the IDE extension share MCP configuration and OAuth
credentials on the same host, so one URL-only entry serves all of them:

```bash
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp
codex mcp login artifact-use
```

In the desktop app the equivalent is **Settings → MCP servers → Add server**,
Streamable HTTP, the URL above, then **Save → Restart → Authenticate**. Remove
any existing `bearer_token_env_var` from the entry first: Codex tries a
configured bearer token before OAuth.

### Path 2: Quick Connect With A Creator Token

For every other harness, and as the Codex fallback when OAuth loops, open
**Connect an agent** in the admin (`/admin/connect`). It mints a creator token
and shows a short, harness-neutral setup prompt; paste that prompt into the
agent. The token appears once, and the prompt points the agent at
[`/llms.txt`](https://artifacts.iofold.com/llms.txt) to pick exactly one setup
path. The same token serves as the bearer credential on the hosted MCP URL
and as `ARTIFACT_USE_TOKEN` for the CLI, the stdio MCP server, and the HTTP
API:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN=<artifact-use-creator-token>
```

Creator tokens expire after 90 days and can be revoked from the same page. An
expired token receives `401` with `error.code` `token_expired` and a
`renew_url`; the agent asks for a fresh token and nothing else changes. The
Codex CLI bearer fallback and client-neutral configs are in
[docs/MCP.md](docs/MCP.md).

### What The Agent Gets

Hosted MCP exposes four tools:

- `artifact_publish`: publish a single HTML string or small inline files (2 MiB
  per file). `artifact` takes a new slug or an existing artifact's `url_key`,
  so a republish updates the same link instead of creating a duplicate.
- `artifact_upload_session`: a short-lived direct upload session for folders
  and large or multi-file artifacts; bytes go straight to the Worker.
- `artifact_manage`: list, stats, access, public preview copy, upstream
  backend, share links, move between workspaces, delete, workspaces.
- `artifact_comments`: list, reply to, resolve, and reopen reviewer threads.

Tool failures come back as `isError` results with
`structuredContent.error = {code, message, status}`. The bundled skill and the
[agent guide](docs/agent-guide.md) tell the agent when to publish, how to run
the comment loop, and what to report; paste the snippet in its last section
into a project's `AGENTS.md` or `CLAUDE.md` to route "share this" requests
through Artifact Use.

### Advanced Fallbacks

The JSON-first CLI, the HTTP API, and the local stdio MCP server cover
harnesses without hosted MCP support and shell workflows that walk local
folders. They use the same creator token. For example, publish a folder:

```bash
npx -y artifact-use publish-folder --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "examples/simple-site",
  "gate_level": "email"
}'
```

The CLI walks the folder, creates a draft version, uploads every file through
service-owned HTTP endpoints, completes the version, and returns a live URL.
Inside this repository, `npm run cli -- ...` runs the same commands from
source. See [docs/API.md](docs/API.md) for the HTTP contract.

## Repository Layout

```text
apps/worker/          Cloudflare Worker, D1 schema, R2 object serving
apps/admin-ui/        Publisher dashboard (React SPA served by the Worker)
packages/client-core/ Shared publish client and MCP tool schemas
packages/cli/         Agent-friendly CLI for publishing and admin operations
packages/mcp-server/  Local stdio MCP server for folder publishing
skills/               Portable Artifact Use skill (Agent Skills format)
plugin.json, mcp.json Agent Plugins 1.0 manifest and MCP config (repo root)
.claude-plugin/       Claude Code plugin manifest and marketplace
.agents/plugins/      Codex marketplace pointing at plugins/codex/artifact-use
plugins/              Codex plugin bundle (skill mirror kept in sync by npm run check)
integrations/         MCP config examples
examples/             Small static folder used for smoke tests
docs/                 Agent guide (source of /llms.txt), API, MCP, deployment, architecture
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

1. Create a Cloudflare D1 database and R2 bucket, and enable Browser Rendering.
2. Configure `apps/worker/wrangler.toml` for your account, domain, routes,
   D1 database, R2 bucket, Browser Rendering binding, and Email Sending binding.
3. Apply the D1 baseline migration.
4. Enable a Cloudflare Email Sending domain if you use `verified_email` gates.
5. Set Worker secrets for sessions and WorkOS.
6. Deploy the Worker.

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
npx wrangler d1 migrations apply artifact-use --remote
npx wrangler email sending enable updates.example.com
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler deploy
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full hosted setup, WorkOS redirect
configuration, MCP auth settings, and Cloudflare route notes.

## Open-Source Scope

The code is MIT licensed. The public repository contains the Worker, schema,
CLI, MCP server, skill, plugin bundle, and docs. Hosted-service configuration
such as WorkOS applications, Cloudflare account IDs, R2/D1 resources, Email
Sending domains, and production secrets remain deploy-time configuration.
Operator-specific privacy policies and terms are not included; self-hosters can
link their own reviewed policies through deployment variables.

Before publishing your own fork or hosted instance, replace the example routes
and WorkOS/AuthKit values in `apps/worker/wrangler.toml` and `.env` files with
your own environment values.
