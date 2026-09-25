# Artifact Use Agent Guide

<!-- This file is the single source for the agent-facing documentation. The
worker build (apps/worker/scripts/build-llms.mjs) renders it into
/llms-full.txt, and the blocks between "llms.txt" markers into the short
/llms.txt index. The hosted base URL and the /go/ prefix are substituted per
deployment, so always write them in full here. -->

<!-- llms.txt -->

Artifact Use publishes static artifacts for agents and teams: self-contained
interactive HTML, multi-file static folders, images, PDFs, dashboards, demos,
and browser-native tools. Every artifact gets one stable URL, immutable
versions, a viewer gate, comments, and stats. Agents publish through MCP, the
CLI, or the HTTP API; they never need Cloudflare credentials.

Primary URLs:

- Site: https://artifacts.iofold.com
- HTTP MCP (POST only): https://artifacts.iofold.com/mcp
- OAuth protected-resource metadata: https://artifacts.iofold.com/.well-known/oauth-protected-resource
- Full agent guide: https://artifacts.iofold.com/llms-full.txt
- Mint or renew a creator token: https://artifacts.iofold.com/admin/connect
- Public artifact URL shape: https://artifacts.iofold.com/go/{artifact-slug}-{six-character-code}/

Artifact Use never publishes unless you call a publish tool. Reading, listing,
stats, and comments change nothing. Publish only when the user asks for a link,
a share, a review, or a republish; prefer republishing the existing artifact
(pass its `url_key` as `artifact`) over creating a new one; and hand the
review link back in your final response.

<!-- /llms.txt -->

## 1. Choose the integration

Use this order:

1. Hosted HTTP MCP at `https://artifacts.iofold.com/mcp`, using the auth path
   for the current harness (section 2).
2. Local stdio MCP (`npx -y artifact-use-mcp`) or the CLI
   (`npx -y artifact-use-cli`) when the agent has to walk a local folder or
   the harness cannot speak hosted MCP.
3. The HTTP API (`docs/API.md`) when neither MCP nor the CLI is available.

Never publish with Wrangler, Cloudflare API tokens, R2 credentials, or direct
D1 access.

## 2. MCP setup

There are exactly two ways to authenticate:

- **OAuth** for clients that support MCP authorization (Claude Code, Codex
  desktop/CLI/IDE, and any client that reads
  `/.well-known/oauth-protected-resource`). No token is involved.
- **A creator token** (quick connect) for everything else: bearer auth on the
  hosted MCP endpoint, the CLI, the stdio MCP server, and the HTTP API. The
  human mints it at `https://artifacts.iofold.com/admin/connect`, which also
  produces a paste-ready setup prompt for the agent.

Do not combine both on one MCP entry: Codex tries a configured bearer token
before its OAuth flow.

<!-- llms.txt -->

Setup: identify the current harness and follow exactly one path.

- Codex desktop / CLI / IDE (OAuth default; do not use the creator token):
  these surfaces share MCP config and OAuth credentials on the same host, so
  one URL-only entry serves all of them. Remove any existing
  `bearer_token_env_var` from the `artifact-use` entry before OAuth, because a
  configured bearer token is tried first. Desktop: Settings -> MCP servers ->
  Add server, choose Streamable HTTP, enter
  `https://artifacts.iofold.com/mcp`, Save, Restart, then Authenticate. CLI:
  `codex mcp add artifact-use --url https://artifacts.iofold.com/mcp` then
  `codex mcp login artifact-use`. Run `/mcp` to confirm it is connected.
- Codex CLI bearer fallback (only when OAuth is unavailable or loops): export
  `ARTIFACT_USE_TOKEN` in the terminal before starting Codex, run
  `codex mcp add artifact-use --url https://artifacts.iofold.com/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN`,
  then start or restart Codex from that terminal and run `/mcp`. An export
  inside an already-running Codex session cannot change its parent process.
- Claude Code (OAuth; do not use the creator token):
  `claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp`,
  then open `/mcp`, select `artifact-use`, and Authenticate in the browser.
- Other harnesses: use hosted MCP OAuth when the client supports it. Otherwise
  configure `https://artifacts.iofold.com/mcp` with the creator token as its
  bearer credential, or run the stdio server / CLI with `ARTIFACT_USE_TOKEN`
  exported. Client-neutral configs are in section 2 of the full guide.
- No token and no OAuth? Ask the user to open
  `https://artifacts.iofold.com/admin/connect`, copy the setup prompt, and
  paste it to you. Tokens expire after 90 days; a `401` whose `error.code` is
  `token_expired` carries a `renew_url` — ask the user to mint a new token
  there. Nothing else in the setup changes.

<!-- /llms.txt -->

### Codex desktop, CLI, and IDE: OAuth

These Codex surfaces share `~/.codex/config.toml` and MCP OAuth credentials on
the same host. A single URL-only entry works across them:

```toml
[mcp_servers.artifact-use]
url = "https://artifacts.iofold.com/mcp"
```

Codex desktop:

1. Open Settings -> MCP servers -> Add server.
2. Name it `artifact-use`, choose Streamable HTTP, and enter
   `https://artifacts.iofold.com/mcp`.
3. Save, select Restart, then Authenticate in the server list.
4. Complete browser sign-in and run `/mcp` in the composer to verify it.

Codex CLI equivalent:

```bash
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp
codex mcp login artifact-use
```

If an existing entry contains `bearer_token_env_var`, remove that key (or
`codex mcp remove artifact-use` and re-add the URL-only entry) before using
OAuth. Adding `auth = "oauth"` while leaving the bearer key in place does not
fix a missing-environment-variable startup failure.

### Codex CLI: bearer fallback

Use bearer MCP only when OAuth is unavailable or keeps looping. The token must
be present in the environment that launches Codex, not merely exported by a
child shell inside an already-running Codex session:

```bash
export ARTIFACT_USE_TOKEN='au_creator_...'
codex mcp remove artifact-use
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN
codex
```

If startup reports `Environment variable ARTIFACT_USE_TOKEN ... is not set`,
exit Codex, export the token in the parent terminal, and launch Codex again.
Run `/mcp` before claiming the connection works.

### Claude Code: OAuth

```bash
claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp
```

Then open `/mcp`, select `artifact-use`, and Authenticate in the browser. Do
not add a creator token or a static `Authorization` header to this path.

### Other OAuth-capable clients

Configure a URL-only HTTP server:

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

The endpoint requires auth from the first request, answers `GET /mcp` with
`405` (there is no SSE stream; use POST), speaks MCP 2026-07-28 as well as the
2025 revisions, and advertises protected-resource metadata at
`https://artifacts.iofold.com/.well-known/oauth-protected-resource`.

### Creator token: CLI, stdio MCP, HTTP API, and non-OAuth clients

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

A stdio MCP entry for clients that launch local servers:

```json
{
  "mcpServers": {
    "artifact-use": {
      "command": "npx",
      "args": ["-y", "artifact-use-mcp"],
      "env": { "ARTIFACT_USE_TOKEN": "au_creator_..." }
    }
  }
}
```

Token lifecycle:

- The human mints tokens at `https://artifacts.iofold.com/admin/connect`
  ("Connect an agent"). The page shows a setup prompt that carries the token
  once and points the agent at `/llms.txt`; the token can be pasted into a
  config or exported as `ARTIFACT_USE_TOKEN`.
- Tokens expire 90 days after minting by default. An expired token gets `401`
  with `error.code` `token_expired` and `error.renew_url` (a revoked one gets
  `token_revoked` with the same `renew_url`); over MCP the tool result has
  `isError: true` and `structuredContent.error.code` `token_expired`. Tell the
  user to mint a new token at the renew URL and swap it in; no other
  configuration changes.
- Tokens are revocable from the same page; revocation applies on the next use.
  Keep tokens out of repositories, logs, config committed to source control,
  and published artifacts.
- WorkOS-authenticated identities can also mint programmatically with
  `POST /api/v1/tokens` `{"label": "...", "expires_days": 90}`; creator tokens
  cannot mint further tokens.

There is no agent-initiated device-code flow; if you have neither OAuth nor a
token, ask the user for the setup prompt from `/admin/connect`.

### Workspaces and user-scoped tokens

Creator tokens are scoped to one workspace by default. A user-scoped token
("All my workspaces" in the admin, or `"scope": "user"` on `POST /api/v1/tokens`)
publishes to any workspace its user belongs to and must name the target on
every publish or manage call:

- MCP: pass `workspace` (organization id or slug) in the tool arguments.
- HTTP: send `X-Artifact-Use-Workspace: <org id or slug>`.
- CLI and stdio MCP: `--workspace`, `ARTIFACT_USE_WORKSPACE`, or a
  `.artifact-use.json` file with `{"workspace": "..."}` at the project root, so
  the pin travels with the project.

Discover workspaces with `artifact_manage {"action": "workspaces"}` or
`GET /api/v1/workspaces`. Org-scoped tokens ignore the header unless it names a
different workspace, which is refused with `workspace_forbidden`.

### Plugin and skill packages

The repository ships the same guidance as installable packages; use whichever
your harness supports instead of hand-writing config:

- Claude Code: `claude plugin marketplace add iofold/artifact-use`, then
  `claude plugin install artifact-use@artifact-use`.
- Codex: `codex plugin marketplace add iofold/artifact-use`, then
  `codex plugin add artifact-use@artifact-use`.
- Any skills-aware agent: `npx skills add iofold/artifact-use`.
- Agent Plugins 1.0 clients: `npx plugins add iofold/artifact-use`, or load the
  repository root (`plugin.json`, `mcp.json`, `skills/`).

Each package registers the hosted MCP endpoint (OAuth) and the `artifact-use`
skill.

## 3. Skill setup

Install the packaged skill (`skills/artifact-use` in the repository, or
`npx skills add iofold/artifact-use`). If no package is available, create a
skill named `artifact-use` with this minimal `SKILL.md`; it defers to this
guide instead of repeating it:

```markdown
---
name: artifact-use
description: Use when the user asks to publish, share, review, gate, or get a link for agent output (HTML tools, dashboards, static folders, images, PDFs) through Artifact Use, or to read and resolve reviewer comments on a published artifact. Use instead of Wrangler, Cloudflare tokens, R2, or direct D1 access.
---

# Artifact Use

Artifact Use publishes static artifacts to https://artifacts.iofold.com.

- Read https://artifacts.iofold.com/llms-full.txt and follow exactly one setup
  path for the current harness (OAuth in Claude Code and Codex; a creator
  token from /admin/connect elsewhere).
- Publish only when the user asks for a link, share, review, or republish.
  Prefer republishing the existing artifact by its `url_key`.
- `artifact_publish` for one HTML string or small inline files;
  `artifact_upload_session` (or the stdio MCP / CLI) for folders and large
  files; `artifact_manage` for list, stats, access, preview copy, upstream,
  share links, move, delete; `artifact_comments` for the review loop.
- Titles and descriptions are public link-preview copy even on gated
  artifacts. Default gate is `email`.
- Report the live URL, gate level, slug and `url_key`, checks run, and any
  error body.
```

## 4. MCP tools

The hosted endpoint exposes four tools; the stdio server exposes the same four
plus `dir` and `dry_run` on `artifact_publish`.

- `artifact_publish`: publish one HTML string (`html`) or a small inline
  multi-file artifact (`files`, each with `content` or `content_base64`;
  every inline file is limited to 2 MiB over hosted MCP). `artifact` is a
  lower-case slug for a new artifact or the `url_key` of an existing one;
  either way an existing artifact is republished in place and keeps its URL.
  `gate_level` is applied when given; on republish an omitted gate keeps the
  current one (first publish defaults to `email`).
- `artifact_upload_session`: create a draft version and a 6-hour bearer
  `upload_token` with `upload_base` and `complete_url`; the agent `PUT`s each
  file directly and `POST`s the manifest to complete. Pass `file_count` and
  `package_bytes` up front to get an immediate `413` (`too_many_files`,
  `package_too_large`) before uploading anything. Also accepts `artifact` as a
  slug or `url_key`.
- `artifact_manage`: `list` (returns `url_key` and `open_comments` per
  artifact), `stats`, `set_access` (`gate_level`, `allowlist`), `set_preview`
  (`title`, `description`), `set_upstream` (`upstream_url`, optional write-only
  `upstream_secret`; omit `upstream_url` to remove), `share_link` (`kind`:
  `recipient` default, `password`, or `open`; `label`, `recipient_email`,
  `recipient_label`, `passcode` for password links — generated when omitted
  and returned once — `expires_days`, `max_opens`; returns the link with its
  `url`), `share_links` (list with `open_count`, `last_opened_at`, `state`),
  `revoke_link` (`link_id`), `move` (`to_workspace`; URL and creator
  preserved), `delete` (requires `confirm: true`; removes every version,
  file, share link, comment, and view record), and `workspaces`.
- `artifact_comments`: `list` (`status` open|sent|resolved|all, `since`,
  `wait` up to 25 s, `page_path`, `limit`; every result carries `next_since`),
  `post` (`body`, optional `parent_id`), `resolve` and `reopen`
  (`comment_id`), `subscribe` (`url`, optional `events`, optional `artifact`),
  `unsubscribe` (`webhook_id`), and `webhooks`.

Selection:

- Single self-contained HTML: `artifact_publish` with `html`.
- Small multi-file payload already in context: `artifact_publish` with `files`.
- Local folder, large images or PDFs, vendored libraries, many files:
  `artifact_upload_session`, stdio MCP with `dir`, or CLI `publish-folder`.
- Anything comment-related: `artifact_comments` (or the HTTP endpoints in
  section 5).

Results and errors:

- Successful calls return the JSON result as text and as `structuredContent`.
  Publish results include `url`, `artifact.url_key`, and `artifact.slug`; use
  the `url_key` for every later management call and never guess it.
- Tool failures come back as a result with `isError: true` and
  `structuredContent.error = {code, message, status}` plus an optional `detail`
  carrying the API's error body (the same `code` the HTTP API uses: `token_expired`, `workspace_forbidden`, `artifact_not_found`,
  `invalid_gate_level`, `too_many_files`, `package_too_large`,
  `file_too_large`, ...). Read the code before retrying; a `401 token_expired`
  is not fixed by retrying.
- Titles and descriptions are public link-preview copy even when the artifact
  is gated. Pass a concise `description` (or let HTML publishes derive one) and
  never put secrets, recipient details, or confidential content in either.
- Default gate is `email` (the viewer's word, checked for syntax and a real
  mail domain, never verified); use `verified_email` — the "share with a
  client" preset — when every view must be attributable, `allowlist` for
  restricted customer material, and `public` only for intentionally
  low-sensitivity artifacts. Upstream backends (section 12) require a
  non-public gate. `set_access` also takes `access_preset`: `open`, `email`,
  `client` (= `verified_email`), `restricted` (= `allowlist`).
- Share links are how a gated artifact reaches people without an account: a
  link passes the gate at every level until it expires, is revoked, or hits
  `max_opens`. Use `recipient` for one named person (views attributed to
  them), `password` when the viewer should type a passcode instead of an
  email (send the passcode separately from the URL), and `open` for "anyone
  with the link". Every artifact URL is unlisted (search engines are told
  not to index it); a share link does not change that.

<!-- llms.txt -->

Tools after connection: `artifact_publish` (one HTML string or small inline
files, 2 MiB per file; `artifact` takes a slug or an existing `url_key` to
republish in place), `artifact_upload_session` (local folders and large or
multi-file artifacts), `artifact_manage` (list, stats, access, preview copy,
upstream backend, share links, move, delete, workspaces), and
`artifact_comments` (list with `wait: 25` to long-poll, reply, resolve,
reopen, subscribe a webhook). Tool failures return
`isError: true` with `structuredContent.error = {code, message, status}`.
Never use Wrangler, Cloudflare API tokens, direct R2, or direct D1 for
publishing.

<!-- /llms.txt -->

## 5. Comment loop

Viewers comment on the artifact page through the built-in widget; comments are
threaded and can be anchored to a specific on-page element. A viewer can press
"Send to agent" on a thread: it is flagged (`status: "sent"`), the
`comment.sent_to_agent` event fires, and the page shows "picked up" once you
reply or resolve. The page also shows "an agent checked this page N min ago"
whenever you list its comments, so keep listing while you work. The
publisher's agent closes the loop:

1. Learn about feedback by push or by holding a request, never by polling on
   a timer:
   - Webhook: `artifact_comments` action `subscribe` with your `url`
     (optional `events`; optional `artifact` to scope to one, omit it for
     the whole workspace). Each event is a signed JSON POST
     (`X-Artifact-Use-Event`, `X-Artifact-Use-Signature: sha256=<HMAC of the
body with the secret returned once>`), retried for 12 hours.
   - Long-poll: `artifact_comments` action `list` with `wait: 25` and
     `since: <next_since from the previous result>`. The call answers as soon
     as a newer comment exists, or `[]` after 25 s with a fresh `next_since`;
     loop on it and de-duplicate by `id`.
2. Act on `status: "sent"` first (a person explicitly asked for you), then
   `status: "open"`. `artifact_manage` action `list` shows `open_comments`
   per artifact when you start cold.
3. Read each thread: roots carry the request; replies hang off
   `parent_comment_id`; `author_kind` says whether a person or an agent wrote
   it; `target` (when present) describes the anchored element: `selector`,
   `label`, `text`, `path`, and on newer comments `tag`, `caption` (alt,
   aria-label, figcaption), `src` (media file name), `heading` (the section
   it sits under), `index`, `viewport` and `page_title`, so "div" on an image
   grid reads as "the second image under Option B".
4. Fix the artifact and republish the SAME artifact (pass its `url_key` or the
   same slug); the URL stays stable and viewers see the new version.
5. Reply to each thread (`action: "post"` with `parent_id`) saying what
   changed, then resolve it (`action: "resolve"` with `comment_id`). Your
   replies are attributed to the agent (`author_kind: "agent"`, labelled with
   the token's name). Use `reopen` if you resolved by mistake.

The same operations over HTTP with a creator bearer token:

```bash
# hold up to 25 s for feedback newer than $NEXT_SINCE; sent threads first
# (filters: status=open|sent|resolved|all, since=<unix>, wait=<1..25>, page_path, limit)
curl -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments?status=sent&since=$NEXT_SINCE&wait=25"

# or subscribe a webhook once (the signing secret is returned once)
curl -X POST -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://hooks.example.com/artifact-use", "artifact": "{url_key}"}' \
  "$ARTIFACT_USE_API_BASE/api/v1/webhooks"

# reply to comment 42, then resolve it
curl -X POST -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"body": "Fixed in v2: the chart now sorts by date.", "parent_id": 42, "client_ref": "reply-42-v2"}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
curl -X PATCH -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"id": 42, "resolved": true}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
```

`POST` returns the created comment (including its `id`), so a follow-up
resolve or reply never needs a re-list. `client_ref` (up to 64 characters) makes
a post idempotent: retrying after a lost response with the same `client_ref`
returns the comment that was already created instead of duplicating it.
Viewer-side agents (delegated or self-served via the gate) use the same shapes
on `/_au/comments` with `artifact_key` in the query or body; see section 14.

## 6. HTML artifact quality

Default to durable no-build artifacts:

- Prefer one self-contained `index.html`.
- Avoid React, JSX, bundlers, package installs, and build steps unless
  explicitly requested or already present.
- Keep HTML/CSS/JS readable enough for a future agent to revise quickly.
- Use semantic HTML, real buttons, labels, ordered headings, alt text, and
  native form controls.
- Make the first viewport useful; do not create a marketing page around a
  future artifact.
- Use stable responsive constraints: grid tracks, `minmax()`, `aspect-ratio`,
  `max-width`, and explicit overflow behavior.
- Support paste, file-open, drag/drop, copy buttons, downloads, URL state, and
  localStorage when they reduce user effort. The artifact gate preserves the
  query string, so URL-addressed state survives the email form.
- Use `textContent` for untrusted text and `innerHTML` only for controlled
  templates.
- Include loading, empty, invalid-input, and error states.
- Never place secrets, private API keys, customer secrets, WorkOS tokens,
  Cloudflare tokens, or Artifact Use tokens in HTML. If the page needs a live
  backend, use an upstream backend (section 12) so the credential stays on the
  server.

## 7. Multi-file artifact rules

Use a folder when a single file would be too large or brittle:

```text
artifact-dir/
  index.html
  assets/
  data/
  lib/
```

Rules:

- Keep `index.html` as the entrypoint unless there is a clear reason not to.
- Use relative paths such as `./assets/image.jpg`; never leading-slash asset
  paths.
- Avoid reserved path segments: `_au`, `_api`, `_iof`, any leading `_`,
  `cdn-cgi`, `.`, `..`.
- Optimize large images and remove unused media.
- Vendor critical libraries into `lib/` when CDN failure would break the
  artifact.
- Verify through a local HTTP server when using sibling assets, modules, or
  `fetch()`.

## 8. CLI examples

Install or run the CLI with `npx -y artifact-use-cli` (the commands below use
the `artifact-use` binary name). All commands print JSON; `--workspace <org id
or slug>` targets a workspace for user-scoped tokens. `artifact-use --help`
prints the usage (every command with its required and optional fields, the
flags, and the environment variables); `artifact-use help <command>` prints
that command's JSON input schema.

Single HTML:

```bash
artifact-use publish-html --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "description": "Review-ready claims workflow and evidence summary.",
  "gate_level": "email",
  "html": "<!doctype html>..."
}'
```

Folder (dry run first, then publish; pass the `url_key` to republish):

```bash
artifact-use publish-folder --dry-run --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'

artifact-use publish-folder --json '{
  "artifact": "claims-demo-a1b2c3",
  "title": "Claims Demo",
  "dir": "dist"
}'
```

Share link (`kind` defaults to `recipient`; `password` links return the
passcode once; `open` links pass for anyone holding the URL):

```bash
artifact-use share --json '{
  "artifact": "claims-demo-a1b2c3",
  "recipient_email": "viewer@example.com",
  "recipient_label": "Viewer",
  "expires_days": 14
}'

artifact-use share --json '{
  "artifact": "claims-demo-a1b2c3",
  "kind": "password",
  "label": "Board review",
  "max_opens": 5
}'
```

Comments:

```bash
artifact-use comments --json '{"artifact": "claims-demo-a1b2c3", "status": "open"}'
artifact-use comments --json '{"artifact": "claims-demo-a1b2c3", "action": "post", "parent_id": 42, "body": "Fixed in v2."}'
artifact-use comments --json '{"artifact": "claims-demo-a1b2c3", "action": "resolve", "comment_id": 42}'
```

Other commands: `list`, `stats`, `gate`, `preview`, `workspaces`, and
`schema --all` (prints every command's JSON schema).

Every publish is scanned for credentials (API keys, private keys, JWTs, this
service's own creator tokens). A hit returns `422` with `error.code`
`secrets_detected` and a `findings` list (`path`, `kind`, `line`, masked
`preview`); nothing is published, so remove the secret and retry. Pass
`"allow_secrets": true` in the publish input to publish anyway; the response
then carries the findings as `warnings`.

## 9. Limits

- Package: 95 MiB.
- Single file: 75 MiB.
- File count: 200.
- Inline file over hosted MCP (`artifact_publish` with `files` or `html`):
  2 MiB per file. Use an upload session, the stdio MCP, or the CLI for
  anything larger.
- Entrypoint: `index.html` by default.
- Declare `file_count` and `package_bytes` on `artifact_upload_session` or
  `POST /api/v1/publish/start` to fail fast with `413` before uploading.
- Comments: 2000 characters per comment; `list` returns up to 500; `wait`
  holds a list for at most 25 s; at most 20 active webhooks per workspace,
  each delivery retried for 12 hours.
- Upstream proxy: 10 MiB request bodies, 60 s timeout, 120 requests per
  minute per viewer and 1200 per artifact.

## 10. Browser QA before sharing

For self-contained HTML:

```bash
agent-browser open "file:///ABSOLUTE/PATH/index.html"
```

For multi-file folders:

```bash
python3 -m http.server 8765 -d artifact-dir
agent-browser open "http://127.0.0.1:8765/"
```

Check desktop, mobile, the primary interaction, empty/error states,
copy/download controls, external dependencies, and console errors. Save
screenshots under `.tmp/html-artifact-qa/<slug>/` when useful.

## 11. Final response after publishing

Report:

- Live URL: `https://artifacts.iofold.com/go/{artifact-slug}-{six-character-code}/`
- Gate level.
- Artifact slug and `url_key` (the user needs the `url_key` to ask for a
  republish later).
- Whether it was a new artifact or a republish, and the share link if one was
  created (for a password link, the passcode — it is shown only once).
- Viewports and interactions checked.
- Any skipped checks, assumptions, or the JSON error body if something failed.

## 12. Upstream backends

An artifact may point at one HTTPS backend. Once a viewer has passed the
artifact gate, requests to the reserved `_api/` path under the artifact URL are
forwarded to that backend, so an interactive artifact can talk to a live
service without running its own login and without shipping a credential in
its HTML.

```json
{
  "action": "set_upstream",
  "artifact": "claims-demo-a1b2c3",
  "upstream_url": "https://intake.example.com",
  "upstream_secret": "backend bearer token"
}
```

- Over HTTP: `PATCH /api/v1/artifacts/{url_key}` with
  `{"upstream": {"base_url": "...", "secret": "..."}}`; `"upstream": null`
  removes it. `GET` returns `upstream: {base_url, path, has_secret, updated_at}`
  or `null`; the secret is never returned.
- `base_url` must be `https://` to a public hostname: no IP literals,
  credentials, query, or fragment, and never the artifact host itself.
- The artifact must have a non-public gate. Configuration refuses `public` +
  upstream from either direction, and the proxy answers `403` as a backstop.
- In the page, call the backend at `_api/<path>` relative to the artifact URL:
  `GET {artifact url}_api/api/items?x=1` becomes `GET {base_url}/api/items?x=1`.
  `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` are forwarded.
- The backend receives `Authorization: Bearer <secret>` (when set),
  `X-Artifact-Key`, `X-Artifact-Viewer-Email` (the gate email),
  `X-Artifact-Viewer-Verified` (`1` or `0`), `X-Artifact-Viewer-Id`, and
  `X-Forwarded-For`, plus `Accept`, `Accept-Language`, `Content-Type`,
  `If-None-Match`, `If-Modified-Since`, and `Range`. Cookies never cross in
  either direction; returned headers are limited to content and caching
  metadata and `Cache-Control` is always `private, no-store`.
- Errors: `404 no_upstream`, `502 upstream_unreachable`,
  `504 upstream_timeout`, `429 upstream_rate_limited` with `Retry-After`.
- Without a viewer session the path answers the machine-readable gate (`401`
  JSON) regardless of `Accept`; the page must be opened through the gate first.

## 13. AGENTS.md / CLAUDE.md snippet

Paste this into a project's `AGENTS.md` or `CLAUDE.md` so every agent in the
repository routes sharing requests through Artifact Use:

```markdown
## Sharing work (Artifact Use)

- When asked to "share this", "make a link", "send for review", or "publish",
  use the Artifact Use MCP tools (guide: https://artifacts.iofold.com/llms-full.txt).
- Publish only when asked; reading, listing, and comments never publish.
- Republish the existing artifact by its `url_key` instead of creating a new one.
- Keep the default `email` gate unless told otherwise; titles and descriptions are public.
- After publishing, return the live URL, the `url_key`, and the gate level.
- For review feedback, subscribe a webhook or long-poll comments with `wait: 25` (carry `next_since`); act on `status: "sent"` first, fix, republish the same artifact, reply, resolve.
```

<!-- llms.txt -->

Reading a gated artifact as an agent (no browser needed):

- The publishing workspace's own token (`au_creator_...` or MCP OAuth) reads
  a gated artifact directly — `GET`/`HEAD` of pages, assets and the
  descriptor — with no viewer session and no view recorded. Fetch the URL you
  just published with the token you already hold.
- Otherwise a gated artifact returns `401` JSON to non-browser requests
  (`Accept` without `text/html`) describing how to authenticate.
- Machine descriptor (structure and files): `GET {artifact-url}_au/index.json`.
- Read any page or file directly with `GET`; HTML is served as-is (the comments
  widget is not injected for agent requests).
- A share link (`{artifact-url}?v={link_id}`) passes the gate by itself:
  `recipient` and `open` links are served inline (cookie attached); a
  `password` link answers `401` with `link_kind: "password"` — exchange the
  passcode for a bearer with `POST /_au/gate/link` (form `artifact_key`,
  `link`, `passcode`; `Accept: application/json`) or send
  `Authorization: Basic base64("{link_id}:{passcode}")` on each request.
  Expired, revoked or exhausted links answer `410`.
- Authenticate with a viewer-session bearer token: email gates self-serve via
  `POST /_au/gate/email` (`Accept: application/json`; the address must parse
  and its domain must have MX or A records); `verified_email` and
  `allowlist` gates self-serve if you can read the inbox
  (`POST /_au/gate/start`, read the one-time code, `POST /_au/gate/verify`), or
  are delegated by the human via "Hand to your agent" in the comments widget
  (`POST /_au/agent-token`). The `401` JSON spells out the exact path.
- Comments with the same bearer:
  `GET /_au/comments?artifact_key={key}&status=open|sent|resolved|all&since=<unix>&wait=<1..25>`
  lists threads (`wait` holds the request until a newer comment exists; pass
  the returned `next_since` back as `since`);
  `POST {artifact_key, body, parent_id?, page_path?, target?, client_ref?}`
  comments or replies and returns the created id;
  `PATCH {artifact_key, id, resolved}` resolves or reopens;
  `PATCH {artifact_key, id, sent_to_agent: true}` flags a thread for the
  publishing agent.
- Publishers close the loop with their own token: the `artifact_comments` MCP
  tool (subscribe a webhook, or list with `wait: 25` and act on
  `status: "sent"` first), CLI `artifact-use comments`, or
  `/api/v1/artifacts/{url_key}/comments`.

<!-- /llms.txt -->

## 14. Reading a gated artifact as an agent

The block above is the complete contract. Two additions for agents that
receive an artifact link from a human:

- The `_au/index.json` descriptor lists the title, pages, files with content
  types, and the entrypoint, so an agent can decide what to fetch before
  fetching it. Every artifact response also carries a
  `Link: <..._au/index.json>; rel="describedby"` header.
- Viewer-session tokens are scoped to one artifact's viewer endpoints (files
  and `/_au/comments`). They cannot publish, list other artifacts, or read
  stats; use a creator token or MCP for those.
- A session minted through a share link carries the link's identity
  (`recipient_email`, or `link:{id}` for password and open links) and stops
  working the moment the link is revoked or expires.

## 15. Views: what your own reads count as

Reading an artifact with your creator token or MCP OAuth token records
nothing: the dashboard's "people" numbers are for the publisher's audience,
not for the agent checking its own work. Fetches that do pass a gate (a
viewer-session bearer, a share link) are recorded but tagged `agent` from your
User-Agent (`claude-code/*`, `codex-mcp-client/*`, `Claude-User`, and the
other harnesses listed in the API docs), and headless browsers or `curl`
runs are tagged `automation`; both are shown separately from people and never
inflate the headline count. `artifact_manage stats` returns
`views.people`, `views.agents`, `views.unique_people`, `views.self_reported`,
`views.verified`, `views.via_link` and `views.public`, so when a human asks
"did anyone look?", answer with `people`, and say "self-reported" for plain
email-gate identities.
