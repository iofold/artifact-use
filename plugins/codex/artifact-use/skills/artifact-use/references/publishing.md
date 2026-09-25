# Publishing With Artifact Use

Use hosted MCP by default. The CLI, local stdio MCP, and hosted API are advanced fallbacks. Do not publish through Wrangler, Cloudflare, direct R2, or direct D1. The full contract is `https://artifacts.iofold.com/llms-full.txt`; this file is the working summary.

Artifact Use never publishes unless you call a publish tool. Publish only when asked, republish the existing artifact by its `url_key`, and hand the link back.

## Hosted MCP (Default)

Default endpoint (Streamable HTTP, POST only; `GET` answers `405`):

```text
https://artifacts.iofold.com/mcp
```

Two auth paths exist. An MCP entry uses exactly one; do not combine a bearer token with OAuth on the same entry, because Codex tries a configured bearer token first.

### Codex Desktop, CLI, And IDE: OAuth

Codex desktop, CLI, and the IDE extension share MCP configuration and OAuth
credentials on the same host. Configure the hosted URL once:

1. Open **Settings → MCP servers → Add server** in the ChatGPT desktop app.
2. Name it `artifact-use`, choose **Streamable HTTP**, and enter the endpoint
   above.
3. Select **Save → Restart → Authenticate** and complete browser sign-in.
4. Run `/mcp` in the composer to confirm the connection.

CLI equivalent:

```bash
codex mcp add artifact-use --url https://artifacts.iofold.com/mcp
codex mcp login artifact-use
```

Do not use the creator token or attach an `Authorization` header on this path.
Before OAuth, remove any `bearer_token_env_var` from the existing
`artifact-use` entry (or remove and re-add the server URL-only).

#### Codex CLI Bearer Fallback

Use this only when OAuth is unavailable or keeps looping. Export the creator
token in the terminal that will launch Codex, replace the URL-only entry, then
restart Codex from that terminal:

```bash
export ARTIFACT_USE_TOKEN='au_creator_...'
codex mcp remove artifact-use
codex mcp add artifact-use \
  --url https://artifacts.iofold.com/mcp \
  --bearer-token-env-var ARTIFACT_USE_TOKEN
codex
```

If startup says `Environment variable ARTIFACT_USE_TOKEN ... is not set`, exit
Codex, export the token in its parent terminal, and relaunch it. Exporting a
variable inside an already-running Codex shell cannot update the parent Codex
process.

### Claude Code: OAuth

```bash
claude mcp add --transport http \
  artifact-use https://artifacts.iofold.com/mcp
```

Open `/mcp`, select `artifact-use`, then choose **Authenticate**. Do not use the
creator token on this path.

### Other Clients: Creator Token (Quick Connect)

Prefer hosted MCP OAuth when the client supports it. Otherwise configure the
endpoint with the creator token as its bearer credential, or run the stdio
server / CLI with the token exported:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

Getting a token: the human opens `https://artifacts.iofold.com/admin/connect`,
copies the setup prompt (it carries the token once), and pastes it to the
agent. Tokens expire after 90 days and can be revoked from the same page. An
expired token receives `401` with `error.code` `token_expired` and
`error.renew_url`; over MCP the result has `isError: true` and
`structuredContent.error.code` `token_expired`. Ask the user for a new token
from the `renew_url`; nothing else in the setup changes. There is no
agent-initiated device-code flow.

### Plugin Packages

Instead of hand-written config, install the package for the harness:
`claude plugin marketplace add iofold/artifact-use` then
`claude plugin install artifact-use@artifact-use`;
`codex plugin marketplace add iofold/artifact-use` then
`codex plugin add artifact-use@artifact-use`; `npx skills add iofold/artifact-use`;
or `npx plugins add iofold/artifact-use`.

## Tools

- `artifact_publish`: publish a single `html` string or small inline `files` (2 MiB per file); pass public-safe `description` copy when available. `artifact` is a slug or an existing `url_key`.
- `artifact_upload_session`: create a 6-hour direct upload token for shell/curl uploads; pass `file_count` and `package_bytes` for an immediate `413` before uploading.
- `artifact_manage`: `list`, `stats`, `set_access`, `set_preview`, `set_upstream`, `share_link`, `move` (`to_workspace`), `delete` (`confirm: true`), `workspaces`.
- `artifact_comments`: `list`, `post` (reply with `parent_id`), `resolve`, `reopen`.

Tool failures return `isError: true` with `structuredContent.error = {code, message, status}` using the HTTP API's error codes.

## Artifact Slug And URL Key Rules

- Publish a new artifact with a lower-case `artifact` slug.
- Republish an existing artifact by passing its `url_key` (from the publish result or `artifact_manage action:"list"`) as `artifact`; the same slug published earlier in the workspace also republishes in place. Omitting `gate_level` on republish keeps the current gate.
- Use the `url_key` for stats, access changes, share links, and comments. Do not guess it; it includes a six-character code from the artifact id.
- Public artifact URLs are under:

```text
https://artifacts.iofold.com/go/{artifact-slug}-{six-character-code}/
```

## MCP Selection

- Single self-contained HTML: use `artifact_publish` with `html`.
- Small multi-file artifact where all file contents are already in context: use `artifact_publish` with `files`.
- Local folder or large files: prefer hosted `artifact_upload_session`; use local stdio MCP with `dir` or CLI `publish-folder` only when hosted MCP is unavailable or the shell workflow specifically requires it.
- Existing artifact stats/access/preview copy/upstream/share links: use `artifact_manage`.
- Reading or acting on viewer comments: use `artifact_comments`.

## Workspaces

User-scoped tokens ("All my workspaces") must name the target workspace on every publish or manage call: `workspace` in MCP arguments, `X-Artifact-Use-Workspace` over HTTP, or `--workspace` / `ARTIFACT_USE_WORKSPACE` / a `.artifact-use.json` file with `{"workspace": "..."}` at the project root for the CLI and stdio MCP. Discover workspaces with `artifact_manage action:"workspaces"`.

## Upstream Backends

`artifact_manage action:"set_upstream"` with `upstream_url` (https, public hostname) and an optional write-only `upstream_secret` points an artifact at one backend. After a viewer passes the gate, requests to `<artifact url>_api/<path>` are forwarded there with `Authorization: Bearer <secret>`, `X-Artifact-Viewer-Email`, and `X-Artifact-Viewer-Verified`, so the page holds no credential. The artifact must have a non-public gate. Omit `upstream_url` to remove the backend.

## Comment Loop

Viewers comment on the artifact page through the built-in widget; comments are
threaded and may be anchored to a specific on-page element. Close the loop:

1. Find work: `artifact_manage action:"list"` → artifacts with `open_comments > 0`,
   or `artifact_comments action:"list", status:"open"` (add `since:<unix>` for
   only-new comments).
2. Read each thread: roots carry the request; replies hang off
   `parent_comment_id`; `target` (when present) describes the anchored element
   (`selector`, `label`, `text`, `path`).
3. Fix and republish the SAME artifact (its `url_key`) — the URL stays stable for viewers.
4. Reply to each thread (`action:"post"`, `parent_id`, `body`) saying what
   changed, then resolve it (`action:"resolve"`, `comment_id`). Use `reopen`
   to undo a resolve.

The same operations over HTTP (`Authorization: Bearer $ARTIFACT_USE_TOKEN`):

```bash
# list open threads (status=open|resolved|all, since=<unix>, page_path, limit)
curl -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments?status=open"

# reply to comment 42, then resolve it
curl -X POST -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"body": "Fixed in v2 — chart now sorts by date.", "parent_id": 42, "client_ref": "reply-42-v2"}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
curl -X PATCH -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"id": 42, "resolved": true}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
```

POST returns the created comment including its `id`, so a follow-up resolve or
reply never needs a re-list. `client_ref` (up to 64 characters) makes a post
idempotent across retries.

## Advanced CLI, HTTP, And Local Stdio Fallbacks

Hosted MCP is the normal path. The JSON-first CLI (`npx -y artifact-use-cli`), the HTTP API, and the local stdio MCP server (`npx -y artifact-use-mcp`) are available for harnesses without hosted MCP support and specialized shell workflows. They use `ARTIFACT_USE_API_BASE` and `ARTIFACT_USE_TOKEN` as above. Keep the token out of config files, source, logs, and published artifacts.

### CLI Examples

Single HTML:

```bash
artifact-use publish-html --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "html": "<!doctype html>..."
}'
```

Folder dry-run, publish, then republish by `url_key`:

```bash
artifact-use publish-folder --dry-run --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'

artifact-use publish-folder --json '{
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

Share link:

```bash
artifact-use share --json '{
  "artifact": "claims-demo-a1b2c3",
  "recipient_email": "viewer@example.com",
  "recipient_label": "Viewer",
  "expires_days": 14
}'
```

Comments:

```bash
artifact-use comments --json '{"artifact": "claims-demo-a1b2c3", "status": "open"}'

artifact-use comments --json '{
  "artifact": "claims-demo-a1b2c3",
  "action": "post",
  "parent_id": 42,
  "body": "Fixed in v2 — chart now sorts by date."
}'

artifact-use comments --json '{"artifact": "claims-demo-a1b2c3", "action": "resolve", "comment_id": 42}'
```

## Direct Upload Session Sketch

After `artifact_upload_session` returns `upload_token`, `upload_base`, and `complete_url`, upload each file with its byte size and SHA-256:

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

Prefer the CLI or local MCP for full folders because they build the manifest and upload every file.

## Limits

- Package: 95 MiB.
- Single file: 75 MiB.
- File count: 200.
- Inline file over hosted MCP: 2 MiB; use upload sessions for large content.
- Entrypoint: `index.html` by default.

## Report After Publishing

- URL.
- Gate level.
- Artifact slug and `url_key`; new artifact or republish.
- Whether a tracked share link was created.
- Any verification skipped.
- Any error body if publishing failed.
