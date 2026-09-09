# Changelog

Notable changes to Artifact Use are documented here.

## Unreleased

- Add per-artifact upstream backends: `PATCH /api/v1/artifacts/{key}` with
  `upstream`, `artifact_manage` action `set_upstream`, and the reserved
  `_api/` path under an artifact URL that forwards gated viewers' requests to
  the backend with a stored bearer secret and the viewer's gate email.
- Preserve the query string across the artifact gate so URL-addressed state
  survives the email form.

## 0.1.0

- Publish single-file and multi-file static artifacts through HTTP, CLI, or MCP.
- Store immutable artifact versions in Cloudflare R2 with metadata in D1.
- Support public, email, verified-email, and allowlist access gates.
- Add targeted comments, replies, resolution, durable retries, and publisher
  administration.
- Add WorkOS/AuthKit publisher authentication and agent connection flows.
- Add public-safe link previews and project showcase artifacts.
