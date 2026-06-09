---
name: artifact-use
description: Use when publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to single-file HTML artifacts and folder/static-site artifacts. Use this instead of Wrangler or Cloudflare tokens.
---

# Artifact Use

Use Artifact Use to publish static artifacts through hosted HTTP MCP at `https://art-use.iofold.com/mcp` and the hosted API at `https://art-use.iofold.com`.

Rules:

- Do not use Wrangler or Cloudflare tokens.
- Prefer HTTP MCP OAuth prompts for auth.
- Use `ARTIFACT_USE_TOKEN` only for CLI, local stdio MCP, or non-OAuth clients.
- Use `artifact_publish` for publishing.
- Use `artifact_manage` for list/stats/access/share-link actions.
- Use local stdio MCP `artifact_publish` with `dir` or the CLI for large local folders.
- Prefer `email` gate by default, `verified_email` for inbox control, and `allowlist` for customer-only access.
- Keep tenant and artifact slugs lower-case hyphen-case.
- Dry-run folder publishes when possible.

MCP tools:

- `artifact_publish`
- `artifact_manage`

Folder limits: 95 MiB package, 75 MiB per file, 200 files, `index.html` entrypoint.
