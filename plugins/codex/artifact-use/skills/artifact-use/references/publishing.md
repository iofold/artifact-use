# Publishing With Artifact Use

Use Artifact Use through MCP, CLI, or the hosted API. Do not publish through Wrangler, Cloudflare, direct R2, or direct D1.

## Hosted MCP

Default endpoint:

```text
https://artifacts.iofold.com/mcp
```

OAuth-capable MCP clients should authenticate from the MCP prompt.

No token and no browser? Self-serve one with the connect flow:

1. `POST https://artifacts.iofold.com/api/v1/connect/start` with JSON
   `{"agent_label": "<who you are>"}` → returns `device_code`, `user_code`,
   and `verification_url`.
2. Ask your human to approve the `user_code` at the `verification_url`.
3. Poll `POST https://artifacts.iofold.com/api/v1/connect/poll` with
   `{"device_code": "..."}` every few seconds until it returns your bearer
   token (delivered once) plus a ready-to-follow setup prompt.
4. Verify with `GET https://artifacts.iofold.com/api/v1/me`.

If Codex's MCP OAuth token refresh is unreliable, use the bearer-token
fallback:

1. Sign in at `https://artifacts.iofold.com/admin`.
2. In **Agent setup**, generate an agent prompt (the token is embedded), or
   use the manual pieces it offers.
3. Export the token before starting Codex:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'
```

4. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.artifact-use]
url = "https://artifacts.iofold.com/mcp"
bearer_token_env_var = "ARTIFACT_USE_TOKEN"
```

Then start a fresh Codex process or open a new thread. Use the same
`ARTIFACT_USE_TOKEN` for non-OAuth clients, the CLI, and local stdio MCP.

Tools:

- `artifact_publish`: publish a single `html` string or small inline `files`.
- `artifact_upload_session`: create a 6-hour direct upload token for shell/curl uploads.
- `artifact_manage`: list artifacts, get stats, change access, or create share links.
- `artifact_comments`: list, post/reply, resolve, or reopen feedback comments.

## Artifact Slug And URL Key Rules

- Publish with a lower-case `artifact` slug.
- Use the returned `url_key` from publish or `artifact_manage action:"list"` for stats, access changes, and share links.
- Do not guess a `url_key`; it includes a six-character code from the artifact id.
- Public artifact URLs are under:

```text
https://artifacts.iofold.com/go/{artifact-slug}-{six-character-code}/
```

## MCP Selection

- Single self-contained HTML: use `artifact_publish` with `html`.
- Small multi-file artifact where all file contents are already in context: use `artifact_publish` with `files`.
- Local folder or large files: use `artifact_upload_session`, local stdio MCP with `dir`, or CLI `publish-folder`.
- Existing artifact stats/access/share links: use `artifact_manage`.
- Reading or acting on viewer feedback: use `artifact_comments`.

## Feedback Loop (Comments)

Viewers comment on the artifact page through the built-in widget; comments are
threaded and may be anchored to a specific on-page element. Close the loop:

1. Find work: `artifact_manage action:"list"` → artifacts with `open_comments > 0`,
   or `artifact_comments action:"list", status:"open"` (add `since:<unix>` for
   only-new feedback).
2. Read each thread: roots carry the request; replies hang off
   `parent_comment_id`; `target` (when present) describes the anchored element
   (`selector`, `label`, `text`, `path`).
3. Fix and republish the SAME slug — the URL stays stable for viewers.
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
  -d '{"body": "Fixed in v2 — chart now sorts by date.", "parent_id": 42}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
curl -X PATCH -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \
  -d '{"id": 42, "resolved": true}' \
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
```

POST returns the created comment including its `id`, so a follow-up resolve or
reply never needs a re-list.

## CLI Examples

Single HTML:

```bash
artifact-use publish-html --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "html": "<!doctype html>..."
}'
```

Folder dry-run and publish:

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
- Entrypoint: `index.html` by default.
- Inline MCP file limit is smaller than service storage limits; use upload sessions for large content.

## Report After Publishing

- URL.
- Gate level.
- Artifact slug and URL key.
- Whether a tracked share link was created.
- Any verification skipped.
- Any error body if publishing failed.
