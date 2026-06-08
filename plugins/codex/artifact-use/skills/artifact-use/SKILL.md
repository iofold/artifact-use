---
name: artifact-use
description: Use when publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to single-file HTML artifacts and folder/static-site artifacts. Use this instead of Wrangler or Cloudflare tokens.
---

# Artifact Use

Use Artifact Use to publish static artifacts through the hosted API at `https://art-use.iofold.com`.

Rules:

- Do not use Wrangler or Cloudflare tokens.
- Authenticate with `ARTIFACT_USE_TOKEN`.
- Use `artifact_use_publish_folder` for local folders and `artifact_use_publish_html` for one-file HTML.
- Prefer `email` gate by default, `verified_email` for inbox control, and `allowlist` for customer-only access.
- Keep tenant and artifact slugs lower-case hyphen-case.
- Dry-run folder publishes when possible.

MCP tools:

- `artifact_use_publish_folder`
- `artifact_use_publish_html`
- `artifact_use_list_artifacts`
- `artifact_use_get_stats`
- `artifact_use_create_share_link`

Folder limits: 95 MiB package, 75 MiB per file, 200 files, `index.html` entrypoint.
