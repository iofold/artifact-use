# Changelog

Notable changes to Artifact Use are documented here.

## Unreleased

- Share links are the sharing primitive: `recipient`, `password` and `open`
  kinds with expiry, max opens, open counts and revoke; passcode links pass
  the gate via a form, JSON or HTTP Basic; dead links answer 410. Migration 0014.
- Gates: a creator or OAuth token of the owning workspace reads pages and
  assets without a viewer session or a view row; the plain email gate checks
  syntax and MX records; `access_preset` aliases the gate levels; admin views
  are labelled verified, via link or self-reported; the landing page and every
  publish response say that URLs are unlisted.
- Comment loop: signed webhooks with retries for `comment.created`,
  `replied`, `resolved`, `reopened` and `sent_to_agent`; long-poll with
  `wait=<1..25>` and `next_since` on both comment endpoints; a Send-to-agent
  action and `status=sent`; v3 element context (caption, heading, src,
  viewport) so image-grid comments stop reading as "div"; agent presence in
  `artifact-context` and the widget; `author_kind` and `agent_label`;
  `page_path` normalised with a backfill. Migration 0015.
- Versions: `GET .../versions`, prior versions served at `_v/<id>/` with a
  banner and `X-Artifact-Version`, promote (rollback), per-file diff with a
  bounded line diff, `base_version_id` on every publish path returning
  `409 version_conflict`, and `links {artifact, version, review}` on publish
  results and artifact reads; MCP actions `versions`, `promote`, `diff`.
- Honest analytics: views carry `kind` (human, agent, automation) and
  `source`; public artifacts count one human view per day; the dashboard and
  stats API report people separately from agents. Migration 0017.
- Secret scan on publish: credential-like strings refuse the publish with
  `422 secrets_detected` unless `allow_secrets: true`, in which case they are
  returned as `warnings`.
- MCP tools carry `title` and `readOnlyHint`/`destructiveHint`/`openWorldHint`
  annotations; a CI budget caps the tool schemas at 12 KB.
- CLI: `help`, `--help`, `-h`, `help <command>` and `--version`.
- `GET /.well-known/openai-apps-challenge` serves the OpenAI plugin-directory
  domain-verification token from `OPENAI_APPS_CHALLENGE_TOKEN`.

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

- Agent documentation has one source: `docs/agent-guide.md` is rendered into
  `/llms.txt` and `/llms-full.txt` by `apps/worker/scripts/build-llms.mjs`
  (wrangler `[build]`, `npm run build`, `npm run typecheck`); `docs/MCP.md`,
  `docs/API.md`, the README and the skill link to it instead of repeating it.
  The guide adds the "publish only when asked" promise, an `AGENTS.md`
  snippet, and documents upstream backends, workspaces, `url_key` republish,
  the 90-day token expiry with `token_expired`/`renew_url`, `isError` tool
  results, and the early `413`.
- The agent-initiated device-code connect flow (`/api/v1/connect/*`) is
  deprecated and removed from agent-facing docs; quick connect
  (`/admin/connect`) and OAuth are the two documented paths.
- The repository root is an Agent Plugins 1.0 package (`plugin.json`,
  `mcp.json`) with a Claude Code plugin/marketplace (`.claude-plugin/`) and a
  Codex marketplace (`.agents/plugins/marketplace.json`).
- `artifact-use-cli` (CLI, bin `artifact-use`), `artifact-use-mcp` (stdio MCP server)
  and `artifact-use-core` (shared client) are publishable at 0.2.0
  as unscoped npm packages (renamed from `@artifact-use/*`; npm rejects the bare
  name `artifact-use` as too similar to an unrelated `artifactuse` package) (`files` limited to
  `dist`, READMEs, `prepack` builds); not yet published.

## 0.1.0

- Publish single-file and multi-file static artifacts through HTTP, CLI, or MCP.
- Store immutable artifact versions in Cloudflare R2 with metadata in D1.
- Support public, email, verified-email, and allowlist access gates.
- Add targeted comments, replies, resolution, durable retries, and publisher
  administration.
- Add WorkOS/AuthKit publisher authentication and agent connection flows.
- Add public-safe link previews and project showcase artifacts.
