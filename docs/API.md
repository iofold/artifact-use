# REST API

All creator/admin endpoints require a bearer token — either a WorkOS
OAuth/AuthKit access token or an `au_creator_...` creator token (minted from
the admin's Connect page or the device-code connect flow):

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
- `artifact_comments`

`artifact_publish` accepts either `html` for a single-file artifact or `files` for small HTTP MCP multi-file artifacts. Each inline file can contain `content` or `content_base64`.

`artifact_upload_session` creates a draft version and returns a 6-hour bearer `upload_token`, `upload_base`, and `complete_url`. Use it when an agent has filesystem and shell/curl access so bytes move directly over HTTP instead of through MCP/model context.

`artifact_manage` also covers the artifact lifecycle: `move` relocates an artifact into another workspace the credential's user belongs to (`POST /api/v1/artifacts/{ref}/move` with `{"workspace": "<org id or slug>"}`; public URL and creator unchanged), and `delete` permanently removes an artifact and all its data (`DELETE /api/v1/artifacts/{ref}`; MCP requires `confirm: true`).

## Publish HTML

```http
POST /api/v1/publish/html
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "description": "A review-ready claims workflow and evidence summary.",
  "gate_level": "email",
  "html": "<!doctype html>..."
}
```

The response includes `artifact.url_key` and `url`. Public URLs use `/go/{artifact-slug}-{six-character-code}/`. `description` is public link-preview copy even when the artifact is gated; keep it free of confidential details. When it is omitted for HTML, Artifact Use derives up to 200 characters from authored description metadata or the first paragraph.

## Publish Folder

Start:

```http
POST /api/v1/publish/start
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "description": "A review-ready claims workflow and evidence summary.",
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
  "description": "A review-ready claims workflow and evidence summary.",
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

## Viewer Comments

The injected comments popup uses the viewer session cookie from the artifact
gate.

```http
GET /_au/comments?artifact_key={url_key}
POST /_au/comments
PATCH /_au/comments
```

`POST /_au/comments` creates either a top-level comment or a reply when
`parent_id` is supplied. Include `artifact_key` in the JSON body. `PATCH /_au/comments` accepts `artifact_key`, `id`, and `resolved` to
mark comments resolved or reopen them. Existing comments from earlier schema
versions remain top-level, unresolved comments after migration.

## Admin

```http
GET /api/v1/me
GET /api/v1/workspaces
GET /api/v1/artifacts
GET /api/v1/artifacts/{artifact_key}
PATCH /api/v1/artifacts/{artifact_key}
GET /api/v1/artifacts/{artifact_key}/stats
POST /api/v1/artifacts/{artifact_key}/share-links
GET /api/v1/artifacts/{artifact_key}/comments
```

User-scoped creator tokens (`"scope": "user"` on `POST /api/v1/tokens`)
publish to any workspace their user belongs to and must send
`X-Artifact-Use-Workspace: <org id or slug>` on every call except
`/api/v1/me` and `/api/v1/workspaces`. Org-scoped tokens (the default) ignore
the header unless it names a different workspace, which is refused with
`workspace_forbidden`.

For compatibility during migration, old `/api/v1/artifacts/{legacy_prefix}/{artifact}` paths are still accepted when they map to an artifact owned by the authenticated org.

Update the public link-preview envelope without republishing file bytes:

```http
PATCH /api/v1/artifacts/{artifact_key}
{
  "title": "Claims review workspace",
  "description": "A concise public summary shown in link previews."
}
```

The title, description, generated thumbnail, and favicon are intentionally available to link-preview crawlers. Access gates continue to protect every artifact file.

Gate levels:

- `public`
- `email`
- `verified_email`
- `allowlist`
