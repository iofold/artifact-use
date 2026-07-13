# MCP Installation

Artifact Use exposes HTTP MCP at:

```text
https://artifacts.iofold.com/mcp
```

The repository also ships a local stdio MCP server for environments that need the tool itself to walk a folder on disk.

## Choose One Auth Path

Remote HTTP MCP requires authentication from the first request. The admin's
**Connect an agent** action copies one short, harness-neutral handoff: its
creator token appears once, and it directs the agent to `/llms.txt` to choose
one matching path. Do not configure both OAuth and bearer auth for the same
server; a configured bearer token takes precedence over the OAuth flow.

### Codex Desktop, CLI, And IDE: Shared OAuth

Codex desktop, CLI, and the IDE extension share `config.toml` and MCP OAuth
credentials on the same host. Configure Artifact Use once with URL-only OAuth:

1. In the ChatGPT desktop app, open **Settings → MCP servers → Add server**.
2. Name it `artifact-use`, choose **Streamable HTTP**, and enter
   `https://artifacts.iofold.com/mcp`.
3. Select **Save**, then **Restart**.
4. Select **Authenticate** and complete the browser sign-in.
5. Run `/mcp` in the composer to confirm the server is connected.

The CLI equivalent writes the same shared configuration and OAuth credentials:

```bash
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp
codex mcp login artifact-use
```

Do not attach the creator token or an `Authorization` header on this path.

If an existing `artifact-use` entry has `bearer_token_env_var`, remove that
setting (or run `codex mcp remove artifact-use` and re-add the URL-only entry)
before OAuth login. Codex tries a configured bearer token before stored OAuth
credentials, so leaving the setting in place can produce the missing
`ARTIFACT_USE_TOKEN` startup error instead of starting OAuth.

#### Codex CLI Bearer Fallback

Use bearer auth only when OAuth is unavailable or unreliable. Export the
creator token in the launcher terminal _before_ Codex starts, replace the
URL-only entry with the bearer configuration, then restart Codex from that same
terminal:

```bash
export ARTIFACT_USE_TOKEN='au_creator_...'
codex mcp remove artifact-use
codex mcp add artifact-use \
  --url https://artifacts.iofold.com/mcp \
  --bearer-token-env-var ARTIFACT_USE_TOKEN
codex
```

The equivalent persisted fallback config is:

```toml
[mcp_servers.artifact-use]
url = "https://artifacts.iofold.com/mcp"
bearer_token_env_var = "ARTIFACT_USE_TOKEN"
```

If startup reports `Environment variable ARTIFACT_USE_TOKEN ... is not set`,
the token was not present in the environment that launched Codex. Exit Codex,
export it in the parent terminal, and launch Codex again. An export performed
inside an already-running Codex shell cannot change its parent process.

### Claude Code: Hosted MCP With OAuth

```bash
claude mcp add --transport http \
  artifact-use https://artifacts.iofold.com/mcp
```

Then open `/mcp` in Claude Code, select `artifact-use`, and choose
**Authenticate**. Do not attach the creator token on this path.

### Other MCP Clients

Prefer hosted MCP OAuth when the client supports it. Configure only
`https://artifacts.iofold.com/mcp` and complete the client's authentication
prompt. If OAuth is unavailable, configure that URL with the supplied creator
token as a bearer credential.

Creator tokens can be revoked from `/admin/connect`; revocation takes effect on
the token's next use. Keep tokens out of config files, source, logs, and
published artifacts.

### Agent Connect (Device-Code Style)

When the agent has no token and no browser, it can request one itself:

1. Agent: `POST /api/v1/connect/start` with optional `{"agent_label": "..."}`
   → `device_code`, `user_code`, `verification_url`, `expires_in` (15 min).
2. Human: open the `verification_url` (or `/admin/connect`), review the label, and
   approve the code from a signed-in publisher session.
3. Agent: `POST /api/v1/connect/poll` with `{"device_code": "..."}` →
   `{"status": "pending"}` until approval, then the bearer token (delivered
   exactly once) plus a short, harness-neutral handoff prompt.

Programmatic minting also exists for OAuth-authenticated identities:
`POST /api/v1/tokens` `{"label": "...", "expires_days": 30}`. Creator tokens
cannot mint further tokens.

## Advanced Fallbacks

Hosted MCP is the default. The repository's JSON-first CLI, direct HTTP API,
and local stdio MCP server are advanced alternatives for clients without hosted
MCP support or specialized shell workflows. They use:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

The portable skill lives under `skills/artifact-use`; the Codex plugin mirror
lives under `plugins/codex/artifact-use`.

## Tools

- `artifact_publish`: publish single HTML, small inline multi-file payloads, or a local `dir` when using the bundled stdio MCP.
- `artifact_upload_session`: create a draft and receive a 6-hour upload token for direct HTTP file upload from a shell/curl-capable agent.
- `artifact_manage`: list artifacts, fetch stats, update access, or create share links. Use the returned `url_key` from `action: "list"` for exact management calls.
- `artifact_comments`: list, reply to, resolve, or reopen comment threads.

## File Publishing Over MCP

HTTP MCP cannot read local files by itself. Use one of these paths:

- Remote `artifact_publish` with `html` for one HTML string.
- Remote `artifact_publish` with `files` for small multi-file artifacts where the agent passes inline text or base64 file content. This is convenient but consumes MCP request size and may consume model context in some clients.
- Remote `artifact_upload_session` for large files or folders when the agent can read local files and make HTTP requests. The tool returns `upload_token`, `upload_base`, and `complete_url`; upload files with `PUT` and complete with a manifest `POST`.
- As an advanced fallback, local stdio MCP `artifact_publish` with `dir`, or the CLI `publish-folder`, for large folders. In this mode the tool reads files from disk and streams bytes to the hosted API; the model only sees the path, manifest, and final URL.

Do not guess public URL keys. Publish with a lower-case artifact slug, then use the returned `url_key` for stats, access changes, and share links.

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
