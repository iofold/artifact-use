---
name: artifact-use
description: Use when publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to single-file HTML artifacts and folder/static-site artifacts. Use this instead of Wrangler or Cloudflare tokens.
---

# Artifact Use

Artifact Use publishes static artifacts to a hosted Cloudflare-backed service without giving agents Cloudflare credentials.

Default hosted API:

```text
https://art-use.iofold.com
```

## Rules

- Never use Wrangler, Cloudflare API tokens, or direct R2 credentials for publishing.
- Authenticate with WorkOS-derived bearer auth via `ARTIFACT_USE_TOKEN`.
- Prefer the MCP tool `artifact_use_publish_folder` for folders and `artifact_use_publish_html` for single-file HTML.
- For CLI usage, prefer `--json` payloads and JSON output.
- Run dry-run before publishing a folder when the artifact is large or generated.
- Keep tenant and artifact slugs lower-case hyphen-case.
- Default gate is `email`; use `verified_email` when inbox control matters; use `allowlist` for customer-only artifacts.

## CLI

```bash
export ARTIFACT_USE_API_BASE=https://art-use.iofold.com
export ARTIFACT_USE_TOKEN=<workos-oauth-token>

artifact-use publish-folder --dry-run --json '{
  "tenant": "acme",
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'

artifact-use publish-folder --json '{
  "tenant": "acme",
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'
```

## MCP Tools

- `artifact_use_publish_folder` publishes a local folder and returns the live URL.
- `artifact_use_publish_html` publishes one HTML string.
- `artifact_use_list_artifacts` lists tenant artifacts.
- `artifact_use_get_stats` returns views, unique viewers, share links, and recent visits.
- `artifact_use_create_share_link` creates tracked share links.

## Folder Constraints

Current v1 limits:

- Package: 95 MiB.
- Single file: 75 MiB.
- File count: 200.
- Required entrypoint: `index.html` unless a future asset-only mode is added.
- Disallowed paths: leading slash, `..`, `_iof`, `_au`, `_` prefixes, and `cdn-cgi`.

## Completion Checklist

After publishing, report:

- Live URL.
- Gate level.
- Tenant/artifact slug.
- Whether a share link was created.
- Any failure reason from the JSON error body.
