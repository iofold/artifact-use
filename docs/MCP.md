# MCP Installation

Artifact Use exposes HTTP MCP at:

```text
https://artifacts.iofold.com/mcp
```

The repository also ships a local stdio MCP server for environments that need the tool itself to walk a folder on disk.

## Auth

Remote HTTP MCP requires auth from the first request. OAuth-capable clients receive a `401` with MCP protected-resource metadata and should prompt for WorkOS/AuthKit sign-in automatically.

For CLI usage, local stdio MCP, or non-OAuth clients, pass a WorkOS bearer token explicitly:

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN=<workos-oauth-token>
```

## Codex

Use the bundled Codex plugin under:

```text
plugins/codex/artifact-use
```

Or copy `integrations/codex.mcp.json` into a project `.mcp.json`. The default config uses HTTP MCP.

## Claude Code

Merge `integrations/claude-code/settings.example.json` into your Claude Code settings. The default config uses HTTP MCP.

## Tools

- `artifact_publish`: publish single HTML, small inline multi-file payloads, or a local `dir` when using the bundled stdio MCP.
- `artifact_upload_session`: create a draft and receive a 6-hour upload token for direct HTTP file upload from a shell/curl-capable agent.
- `artifact_manage`: list artifacts, fetch stats, update access, or create share links. Use the returned `url_key` from `action: "list"` for exact management calls.

## File Publishing Over MCP

HTTP MCP cannot read local files by itself. Use one of these paths:

- Remote `artifact_publish` with `html` for one HTML string.
- Remote `artifact_publish` with `files` for small multi-file artifacts where the agent passes inline text or base64 file content. This is convenient but consumes MCP request size and may consume model context in some clients.
- Remote `artifact_upload_session` for large files or folders when the agent can read local files and make HTTP requests. The tool returns `upload_token`, `upload_base`, and `complete_url`; upload files with `PUT` and complete with a manifest `POST`.
- Local stdio MCP `artifact_publish` with `dir`, or the CLI `publish-folder`, for large folders. In this mode the tool reads files from disk and streams bytes to the hosted API; the model only sees the path, manifest, and final URL.

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
