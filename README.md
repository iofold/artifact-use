# Artifact Use

Artifact Use is an open-source artifact publishing service for AI agents and teams.
It hosts static HTML/folder artifacts on Cloudflare R2 behind a Cloudflare Worker, tracks viewer access in D1, and uses WorkOS OAuth/AuthKit for artifact creator auth.

The default hosted API is planned at `https://artifacts.iofold.com`.

## What It Does

- Publishes single-file HTML or complete static folders.
- Serves stable artifact URLs such as `https://artifacts.iofold.com/go/claims-demo-a1b2c3/`.
- Keeps every publish as an immutable version and atomically flips the current version.
- Supports DocSend-style gates: `public`, `email`, `verified_email`, and `allowlist`.
- Tracks views, share links, viewer email attribution, and lightweight comments.
- Exposes the same backend through REST, a JSON-first CLI, and an MCP server for coding agents.
- Keeps Cloudflare credentials inside the Worker. Agents never need Wrangler or Cloudflare API tokens.

Existing direct links on `https://artifacts.iofold.com/<slug>/` continue to belong to the legacy legacy artifact host artifact Worker.
Artifact Use owns the homepage and reserved product routes, with new public artifact links under `/go/`.

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

Use the hosted HTTP MCP endpoint:

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

The MCP endpoint requires auth from the first request. OAuth-capable clients should prompt for WorkOS/AuthKit sign-in after receiving the protected-resource challenge.

The local stdio MCP server remains available for environments that need a local tool to walk a folder from disk.

## Cloudflare Setup

Create the D1 database and R2 bucket, then fill the IDs in `apps/worker/wrangler.toml`.

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
npx wrangler d1 migrations apply artifact-use --remote
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler deploy
```

## Publish a Folder

```bash
npm run cli -- publish-folder --json '{
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

MCP exposes two tools:

- `artifact_publish`: publish single HTML, small inline multi-file payloads, or a local `dir` when using the bundled stdio MCP.
- `artifact_manage`: list artifacts, fetch stats, update access, or create share links. Use the `url_key` returned by `action: "list"` for exact artifact management.

Remote HTTP MCP cannot read local files by itself. Use inline `files` only for small artifacts. For large folders, use the bundled local stdio MCP or CLI so the tool can walk the filesystem and upload bytes directly to the hosted API without putting file contents in model context.

## Open-Source Scope

The repository is MIT licensed and intentionally keeps the hosted service configuration outside source control. WorkOS organization/application setup, Cloudflare account IDs, and transactional email secrets are deploy-time configuration.
