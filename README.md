# Artifact Use

Artifact Use is an open-source, multi-tenant artifact publishing service for AI agents and teams.
It hosts static HTML/folder artifacts on Cloudflare R2 behind a Cloudflare Worker, tracks viewer access in D1, and uses WorkOS OAuth/AuthKit for artifact creator auth.

The default hosted API is planned at `https://art-use.iofold.com`.

## What It Does

- Publishes single-file HTML or complete static folders.
- Serves tenant-prefixed URLs such as `https://art-use.iofold.com/acme/claims-demo/`.
- Keeps every publish as an immutable version and atomically flips the current version.
- Supports DocSend-style gates: `public`, `email`, `verified_email`, and `allowlist`.
- Tracks views, share links, viewer email attribution, and lightweight comments.
- Exposes the same backend through REST, a JSON-first CLI, and an MCP server for coding agents.
- Keeps Cloudflare credentials inside the Worker. Agents never need Wrangler or Cloudflare API tokens.

## Repository Layout

```text
apps/worker/          Cloudflare Worker, D1 migrations, R2 object serving
packages/cli/         Agent-friendly CLI for publishing and admin operations
packages/mcp-server/  Local MCP server that calls the hosted API
skills/               Portable Claude Code/Codex skill
plugins/              Codex plugin bundle
integrations/         MCP config examples for Claude Code and other clients
examples/             Small static folder used for smoke tests
```

## Local Setup

```bash
npm install
npm run typecheck
```

Run the Worker locally:

```bash
npm run worker:dev
```

Run the CLI in JSON mode:

```bash
ARTIFACT_USE_TOKEN=... npm run cli -- schema --all
```

Run the local MCP server:

```bash
ARTIFACT_USE_TOKEN=... npm run mcp
```

## Cloudflare Setup

Create the D1 database and R2 bucket, then fill the IDs in `apps/worker/wrangler.toml`.

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
npx wrangler d1 migrations apply artifact-use --remote
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

## Publish a Folder

```bash
npm run cli -- publish-folder --json '{
  "tenant": "acme",
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "examples/simple-site",
  "gate_level": "email"
}'
```

The CLI will:

1. Walk the folder and build a manifest.
2. Create a draft version.
3. Upload every file through the service-owned Worker API.
4. Complete the version and receive a live URL.

## Open-Source Scope

The repository is MIT licensed and intentionally keeps the hosted service configuration outside source control. WorkOS tenant setup, Cloudflare account IDs, and transactional email secrets are deploy-time configuration.
