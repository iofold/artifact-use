# Changelog

Notable changes to Artifact Use are documented here.

## Unreleased

- Versions carry a change note: every publish path (REST `publish/html`,
  `publish/start`, `publish/upload-session`; MCP `artifact_publish` and
  `artifact_upload_session`; the stdio server, CLI and client-core) accepts
  an optional one-line `change_note` (at most 280 characters after
  whitespace collapses; longer is `400 change_note_too_long` before anything
  is written). It is returned on the versions list, `/_au/versions` and
  publish results, which also carry `next`: how to republish with the
  `url_key`, `base_version_id` and a note. Migration 0018.
- Admin Versions panel: each version leads with its change note (or a file
  summary such as "2 files: 1 added, 1 modified" when it has none) and reads
  the same history as the widget; "Compare with current" and its
  `/admin/artifact/diff` route are removed (the diff API and MCP action
  remain). The widget's publisher-only Versions section shows the note too.
- Upstream proxy: on `allowlist` artifacts every `_api/` request re-checks
  the artifact's current allowlist against the viewer's gate email, so
  password and open share-link sessions, unlisted recipients and workspace
  members, and addresses removed after their session was minted get
  `403 email_not_allowed`; a malformed allowlist denies instead of throwing.
- Gates: "Send code" no longer sends two emails on a double tap. System
  pages submit each form once (the button disables and reads "Sending code…"
  until the page changes, and comes back after a back navigation), and a
  repeat `POST /_au/gate/start` for the same artifact and email within 30
  seconds reuses the code already sent instead of mailing and voiding it;
  it costs no rate-limit quota and answers `resent: false` with
  `retry_after`.
- Prior versions are for the publishing workspace only: `_v/<id>/` answers a
  workspace token or a signed-in member's browser and redirects everyone else
  to the stable URL, so viewers only ever see the current version. Publishers
  get a collapsed Versions line in the comments panel (which version this is,
  how many exist) that expands into the history with each publish's file
  changes and thread counts; `GET /_au/versions?artifact_key=` backs it and
  answers the workspace only.
- Comments: the "Send to agent" action is gone. Every comment already reaches
  the publishing agent, so the widget no longer asks viewers to send anything;
  `status` is `open`, `resolved` or `all` (a legacy `status=sent` reads as
  `open`), the `comment.sent_to_agent` webhook event is retired, and a
  `sent_to_agent` PATCH from an older client is accepted and ignored.
- Share links are the sharing primitive: `recipient`, `password` and `open`
  kinds with expiry, max opens, open counts and revoke; passcode links pass
  the gate via a form, JSON or HTTP Basic; dead links answer 410. Migration 0014.
- Gates: a creator or OAuth token of the owning workspace reads pages and
  assets without a viewer session or a view row; the plain email gate checks
  syntax and MX records; `access_preset` aliases the gate levels; admin views
  are labelled verified, via link or self-reported; the landing page and every
  publish response say that URLs are unlisted.
- Comment loop: signed webhooks with retries for `comment.created`,
  `replied`, `resolved` and `reopened`; long-poll with `wait=<1..25>` and
  `next_since` on both comment endpoints; v3 element context (caption, heading, src,
  viewport) so image-grid comments stop reading as "div"; agent presence in
  `artifact-context` and the widget; `author_kind` and `agent_label`;
  `page_path` normalised with a backfill. Migration 0015.
- Versions: `GET .../versions`, prior versions served at `_v/<id>/` (workspace
  only) with a banner and `X-Artifact-Version`, promote (rollback), per-file diff with a
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
  `dist`, READMEs, `prepack` builds); published to npm on 2026-09-25 as
  `artifact-use-core`, `artifact-use-mcp` and `artifact-use-cli` 0.2.0.

## 0.1.0

- Publish single-file and multi-file static artifacts through HTTP, CLI, or MCP.
- Store immutable artifact versions in Cloudflare R2 with metadata in D1.
- Support public, email, verified-email, and allowlist access gates.
- Add targeted comments, replies, resolution, durable retries, and publisher
  administration.
- Add WorkOS/AuthKit publisher authentication and agent connection flows.
- Add public-safe link previews and project showcase artifacts.
