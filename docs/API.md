# REST API

All creator/admin endpoints require a WorkOS OAuth/AuthKit bearer token:

```http
Authorization: Bearer <token>
```

The hosted API defaults to:

```text
https://artifacts.iofold.com
```

## OAuth Metadata

```http
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-authorization-server
```

The OAuth protected resource is the hosted MCP endpoint:

```text
https://artifacts.iofold.com/mcp
```

## MCP

```http
GET /mcp
POST /mcp
```

Both `GET /mcp` and `POST /mcp` require creator auth. Unauthenticated requests return `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge so OAuth-capable MCP clients can discover WorkOS/AuthKit and prompt sign-in before tool discovery.

Tools:

- `artifact_publish`
- `artifact_upload_session`
- `artifact_manage`

`artifact_publish` accepts either `html` for a single-file artifact or `files` for small HTTP MCP multi-file artifacts. Each inline file can contain `content` or `content_base64`.

`artifact_upload_session` creates a draft version and returns a 6-hour bearer `upload_token`, `upload_base`, and `complete_url`. Use it when an agent has filesystem and shell/curl access so bytes move directly over HTTP instead of through MCP/model context.

## Publish HTML

```http
POST /api/v1/publish/html
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "html": "<!doctype html>..."
}
```

The response includes `artifact.url_key` and `url`. Public URLs use `/go/{artifact-slug}-{six-character-code}/`.

## Publish Folder

Start:

```http
POST /api/v1/publish/start
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "entrypoint": "index.html"
}
```

For direct upload without reusing the creator OAuth token for every file, create a short-lived upload session:

```http
POST /api/v1/publish/upload-session
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "entrypoint": "index.html",
  "ttl_seconds": 21600
}
```

The response includes `upload_token`, `upload_base`, and `complete_url`. The token is scoped to that draft version and expires after at most 6 hours.

Upload each file:

```http
PUT /api/v1/publish/{version_id}/files/index.html
Authorization: Bearer <creator-token-or-upload-token>
Content-Length: 1234
Content-Type: text/html; charset=utf-8
X-Artifact-Sha256: ...
```

Complete:

```http
POST /api/v1/publish/{version_id}/complete
Authorization: Bearer <creator-token-or-upload-token>
{
  "entrypoint": "index.html",
  "files": [
    {
      "path": "index.html",
      "content_type": "text/html; charset=utf-8",
      "size": 1234,
      "sha256": "..."
    }
  ]
}
```

## Viewer Feedback

The injected feedback popup uses the viewer session cookie from the artifact
gate.

```http
GET /_au/comments?artifact_key={url_key}
POST /_au/comments
PATCH /_au/comments
```

`POST /_au/comments` creates either a top-level comment or a reply when
`parent_id` is supplied. Include `artifact_key` in the JSON body. `PATCH /_au/comments` accepts `artifact_key`, `id`, and `resolved` to
mark feedback resolved or reopen it. Existing comments from earlier schema
versions remain top-level, unresolved comments after migration.

## Admin

```http
GET /api/v1/artifacts
GET /api/v1/artifacts/{artifact_key}
PATCH /api/v1/artifacts/{artifact_key}
GET /api/v1/artifacts/{artifact_key}/stats
POST /api/v1/artifacts/{artifact_key}/share-links
GET /api/v1/artifacts/{artifact_key}/comments
```

For compatibility during migration, old `/api/v1/artifacts/{legacy_prefix}/{artifact}` paths are still accepted when they map to an artifact owned by the authenticated org.

Gate levels:

- `public`
- `email`
- `verified_email`
- `allowlist`
