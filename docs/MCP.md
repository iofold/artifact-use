# MCP Installation

Artifact Use exposes HTTP MCP at:

```text
https://artifacts.iofold.com/mcp
```

The endpoint is Streamable HTTP, POST only: `GET /mcp` answers `405` and there
is no SSE stream. It speaks MCP 2026-07-28 (stateless, `Mcp-Method` header,
`server/discover`) and still accepts the 2025-03-26, 2025-06-18 and
2025-11-25 revisions for older clients. It requires authentication from the
first request and advertises OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource`.

The repository also ships a local stdio MCP server (`artifact-use-mcp`)
for environments that need the tool itself to walk a folder on disk.

Agent behaviour (what to publish and when, the comment loop, HTML quality,
browser QA, the final report) lives in one place:
[docs/agent-guide.md](agent-guide.md), served to agents as
[`/llms.txt`](https://artifacts.iofold.com/llms.txt) (short index) and
[`/llms-full.txt`](https://artifacts.iofold.com/llms-full.txt) (full guide).
This page covers installation and the wire-level contract.

## Choose One Auth Path

There are two documented ways to authenticate, and an MCP entry uses exactly
one of them. Do not configure both on the same server: Codex tries a
configured bearer token before its OAuth flow.

### OAuth: Claude Code and Codex

Claude Code:

```bash
claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp
```

Then open `/mcp`, select `artifact-use`, and choose **Authenticate**.

Codex desktop, CLI, and the IDE extension share `config.toml` and MCP OAuth
credentials on the same host, so one URL-only entry serves all of them:

```bash
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp
codex mcp login artifact-use
```

In the desktop app the equivalent is **Settings → MCP servers → Add server**,
Streamable HTTP, the URL above, then **Save → Restart → Authenticate**. If an
existing entry has `bearer_token_env_var`, remove it (or
`codex mcp remove artifact-use` and re-add the URL-only entry) before OAuth
login, otherwise Codex reports the missing `ARTIFACT_USE_TOKEN` instead of
starting OAuth.

Other OAuth-capable clients configure the URL only:

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

### Quick connect: a creator token for everything else

The admin's **Connect an agent** page (`/admin/connect`) mints a creator token
and shows a short, harness-neutral setup prompt. Paste the prompt into the
agent: the token appears once and the prompt directs the agent to `/llms.txt`
to pick its own path. Use the token as:

- the bearer credential on the hosted MCP URL for clients without OAuth;
- `ARTIFACT_USE_TOKEN` for the CLI, the stdio MCP server, and the HTTP API;
- the Codex CLI bearer fallback when OAuth is unavailable or loops:
  `export ARTIFACT_USE_TOKEN=...` in the launcher terminal, then
  `codex mcp add artifact-use --url https://artifacts.iofold.com/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN`
  and restart Codex from that terminal (an export inside a running Codex
  session cannot change its parent process).

Token lifecycle:

- Creator tokens expire 90 days after minting by default and can be revoked
  from `/admin/connect`; revocation takes effect on the token's next use.
- An expired token receives `401` with `error.code` `token_expired` and
  `error.renew_url` pointing at `/admin/connect` (a revoked token gets
  `token_revoked` with the same `renew_url`). Over MCP the tool result carries
  `isError: true` and `structuredContent.error.code` `token_expired`. Mint a new
  token and swap it in; nothing else changes. The admin's connect page shows
  each token's status and last use, and an expiry reminder email goes out
  seven days before a token expires.
- WorkOS-authenticated identities can mint programmatically with
  `POST /api/v1/tokens` `{"label": "...", "expires_days": 90}` (optionally
  `"scope": "user"`, see Workspaces). Creator tokens cannot mint further
  tokens.
- Keep tokens out of config files committed to source control, logs, and
  published artifacts.

The agent-initiated device-code endpoints (`POST /api/v1/connect/start` and
`POST /api/v1/connect/poll`) are deprecated: they still answer, but they are no
longer documented for agents because most requests were never approved; use
quick connect instead.

### Plugin And Skill Packages

The repository root is an Agent Plugins 1.0 package (`plugin.json`,
`mcp.json`, `skills/artifact-use`), a Claude Code plugin and marketplace
(`.claude-plugin/`), and a Codex marketplace (`.agents/plugins/marketplace.json`
pointing at `plugins/codex/artifact-use`). Each installs the hosted MCP entry
(OAuth) together with the `artifact-use` skill:

```bash
claude plugin marketplace add iofold/artifact-use && claude plugin install artifact-use@artifact-use
codex plugin marketplace add iofold/artifact-use && codex plugin add artifact-use@artifact-use
npx skills add iofold/artifact-use
npx plugins add iofold/artifact-use
```

## Advanced Fallbacks

Hosted MCP is the default. The JSON-first CLI (`npx -y artifact-use-cli`),
the HTTP API ([docs/API.md](API.md)), and the local stdio MCP server
(`npx -y artifact-use-mcp`) are alternatives for clients without
hosted MCP support or for shell workflows that walk local folders. They use:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

The portable skill lives under `skills/artifact-use`; the Codex plugin mirror
lives under `plugins/codex/artifact-use` (`npm run check` keeps them
identical).

## Tools

- `artifact_publish`: publish single HTML, small inline multi-file payloads (2 MiB per inline file over hosted MCP), or a local `dir` when using the bundled stdio MCP. `artifact` is a lower-case slug for a new artifact or the `url_key` of an existing one; both republish an existing artifact in place instead of creating a duplicate.
- `artifact_upload_session`: create a draft and receive a 6-hour upload token for direct HTTP file upload from a shell/curl-capable agent. Pass `file_count` and `package_bytes` to get an immediate `413` before uploading.
- `artifact_manage`: list artifacts, fetch stats, update access, edit public preview copy with `set_preview`, point an artifact at a backend with `set_upstream` (`upstream_url`, optional write-only `upstream_secret`; gated viewers reach it through `<artifact url>_api/<path>` and the backend receives `X-Artifact-Viewer-Email`; omit `upstream_url` to remove it; the artifact must have a non-public gate), create share links, move an artifact to another workspace its user belongs to with `action: "move"` (`to_workspace`: org id or slug; URL and creator preserved), permanently delete with `action: "delete"` (requires `confirm: true`; removes every version, file, share link, comment, and view record), or list workspaces with `action: "workspaces"`. Use the returned `url_key` from `action: "list"` for exact management calls.
- `artifact_comments`: list, reply to, resolve, or reopen comment threads.

Results: a successful call returns the JSON result both as text content and as
`structuredContent`. A failed call returns a result with `isError: true` whose
`structuredContent.error` is `{code, message, status}`, using the same `code`
values as the HTTP API (`token_expired`, `workspace_forbidden`,
`artifact_not_found`, `too_many_files`, `package_too_large`, ...).

## Workspaces

Creator tokens come in two scopes. The default `org` scope pins the token to
one workspace. A `user`-scoped token (minted with "All my workspaces" in the
admin, or with `"scope": "user"` on `POST /api/v1/tokens`) can publish to any
workspace its user is an active WorkOS member of, and must name the target
workspace on every publish/manage call:

- MCP: pass `workspace` (org id or slug) in the tool arguments.
- HTTP: send the `X-Artifact-Use-Workspace` header.
- CLI / stdio MCP: `--workspace`, `ARTIFACT_USE_WORKSPACE`, or a
  `.artifact-use.json` file with `{"workspace": "..."}` at the project root —
  the pin travels with the project so one credential cannot cross client
  boundaries by accident.

Discover workspaces with `artifact_manage {"action": "workspaces"}` or
`GET /api/v1/workspaces`. Memberships are validated against WorkOS through a
short-lived snapshot, so removing a member revokes that workspace within
about five minutes without touching their other workspaces.

## File Publishing Over MCP

HTTP MCP cannot read local files by itself. Use one of these paths:

- Remote `artifact_publish` with `html` for one HTML string.
- Remote `artifact_publish` with `files` for small multi-file artifacts where the agent passes inline text or base64 file content (2 MiB per file). This is convenient but consumes MCP request size and may consume model context in some clients.
- Remote `artifact_upload_session` for large files or folders when the agent can read local files and make HTTP requests. The tool returns `upload_token`, `upload_base`, and `complete_url`; upload files with `PUT` and complete with a manifest `POST`.
- As an advanced fallback, local stdio MCP `artifact_publish` with `dir`, or the CLI `publish-folder`, for large folders. In this mode the tool reads files from disk and streams bytes to the hosted API; the model only sees the path, manifest, and final URL.

Do not guess public URL keys. Publish with a lower-case artifact slug, then use the returned `url_key` for republishing, stats, access changes, and share links.

Pass a concise `description` when publishing. It becomes public link-preview copy even for gated artifacts; HTML publishes derive it from page metadata or the first paragraph when omitted. Edit it later with:

```json
{
  "action": "set_preview",
  "artifact": "claims-demo-a1b2c3",
  "title": "Claims review workspace",
  "description": "A concise public summary for reviewers."
}
```

Direct upload session sketch:

```bash
sha=$(sha256sum dist/index.html | awk '{print $1}')
size=$(wc -c < dist/index.html | tr -d ' ')
curl -X PUT "$upload_base/index.html" \
  -H "Authorization: Bearer $upload_token" \
  -H "Content-Length: $size" \
  -H "Content-Type: text/html; charset=utf-8" \
  -H "X-Artifact-Sha256: $sha" \
  --data-binary @dist/index.html

curl -X POST "$complete_url" \
  -H "Authorization: Bearer $upload_token" \
  -H "Content-Type: application/json" \
  --data '{"entrypoint":"index.html","files":[{"path":"index.html","content_type":"text/html; charset=utf-8","size":1234,"sha256":"..."}]}'
```
