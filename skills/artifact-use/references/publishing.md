# Publishing With Artifact Use

Use Artifact Use through MCP, CLI, or the hosted API. Do not publish through Wrangler, Cloudflare, direct R2, or direct D1.

## Hosted MCP

Default endpoint:

```text
https://artifacts.iofold.com/mcp
```

OAuth-capable MCP clients should authenticate from the MCP prompt. Non-OAuth clients, the CLI, and local stdio MCP need a bearer token:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN=<workos-oauth-token>
```

Tools:

- `artifact_publish`: publish a single `html` string or small inline `files`.
- `artifact_upload_session`: create a 6-hour direct upload token for shell/curl uploads.
- `artifact_manage`: list artifacts, get stats, change access, or create share links.

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
