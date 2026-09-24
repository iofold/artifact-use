# Changelog

Notable changes to Artifact Use are documented here.

## Unreleased

- Reserved or malformed segments under an artifact URL (`_au/…`, `_iof/…`,
  `cdn-cgi/…`) answer 404 instead of surfacing as `500 internal_error`.
- The stdio MCP server, CLI and client-core no longer send a default
  `gate_level` on republish, so a public artifact stays public; the first
  package-level tests cover it (`npm run test:packages`).
- Upstream backends require a gated artifact: configuration refuses
  `public` + upstream from either direction and the `_api/` proxy returns
  403 as a backstop. The proxy is rate-limited per viewer (120/min) and per
  artifact (1200/min) with `Retry-After`.
- Publish sessions accept optional `file_count` and `package_bytes` for an
  immediate 413 before any upload; a 413 at completion purges the draft's
  files instead of leaving them in R2.
- A six-hourly cron sweeps upload sessions older than 24 hours and deletes
  artifact shells with no versions (`[triggers]` in `wrangler.toml`).
- `/robots.txt` keeps crawlers off operator and machine paths; `/favicon.ico`
  resolves to the artifact icon. Both need routes in explicit-route deploys.
- Link-preview cards resolve any revision to the current card, so cached
  Slack unfurls no longer break after a republish.
- `npm run deploy` and `deploy:prod` refuse to deploy when a configured
  local legal-policy page is missing from `public/legal/`.
- Dependency audit advisories resolved; `npm audit --audit-level=high`
  passes again.

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
