# REST API

All creator/admin endpoints require a bearer token — either a WorkOS
OAuth/AuthKit access token or an `au_creator_...` creator token minted from the
admin's Connect page (`/admin/connect`):

```http
Authorization: Bearer <token>
```

Creator tokens expire 90 days after minting by default. An expired token
receives `401` with `error.code` `token_expired` and a `renew_url` pointing at
`/admin/connect`; mint a new token there and retry. Every error body has the
shape `{"error": {"code": "...", "message": "..."}}`.

How agents should behave on top of this API (when to publish, the comment
loop, quality checks) is documented once in [docs/agent-guide.md](agent-guide.md),
served as `/llms.txt` and `/llms-full.txt`.

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
POST /mcp
```

`POST /mcp` requires creator auth; `GET /mcp` returns `405` (Streamable HTTP without an SSE stream). Unauthenticated requests return `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge so OAuth-capable MCP clients can discover WorkOS/AuthKit and prompt sign-in before tool discovery. Tool failures are returned as results with `isError: true` and `structuredContent.error = {code, message, status}`, using the same error codes as this API. See [docs/MCP.md](MCP.md) for installation.

Tools:

- `artifact_publish`
- `artifact_upload_session`
- `artifact_manage`
- `artifact_comments`

`artifact_publish` accepts either `html` for a single-file artifact or `files` for small HTTP MCP multi-file artifacts. Each inline file can contain `content` or `content_base64` and is limited to 2 MiB over hosted MCP. Like the publish endpoints below, `artifact` accepts a new slug or an existing artifact's `url_key`.

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

The response includes `artifact.url_key` and `url`. Public URLs use `/go/{artifact-slug}-{six-character-code}/`. `artifact` is either a lower-case slug (a new artifact, or the same slug published earlier in this workspace) or an existing artifact's `url_key`; both republish the existing artifact in place, so passing a `url_key` never creates a duplicate. `gate_level` defaults to `email` on the first publish and is left unchanged on republish when omitted. `description` is public link-preview copy even when the artifact is gated; keep it free of confidential details. When it is omitted for HTML, Artifact Use derives up to 200 characters from authored description metadata or the first paragraph.

## Publish Folder

Start:

```http
POST /api/v1/publish/start
{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "description": "A review-ready claims workflow and evidence summary.",
  "gate_level": "email",
  "entrypoint": "index.html",
  "file_count": 12,
  "package_bytes": 4194304
}
```

`file_count` and `package_bytes` are optional declarations of what is about to be uploaded. When either exceeds the service limit the request fails immediately with `413` (`too_many_files` or `package_too_large`) and no draft is created; the response otherwise includes `limits` (`package_bytes`, `file_bytes`, `file_count`) for the client to check against. `upload-session` accepts the same two fields.

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
`parent_id` is supplied. Include `artifact_key` in the JSON body. An optional
`client_ref` (up to 64 characters, unique per artifact) makes the post
idempotent: a retry with the same `client_ref` after a lost response returns
the comment that was already created. `PATCH /_au/comments` accepts
`artifact_key`, `id`, and `resolved` to mark comments resolved or reopen them.
The publisher endpoint `POST /api/v1/artifacts/{artifact_key}/comments`
accepts the same `body`, `parent_id`, `page_path`, and `client_ref` fields.
Existing comments from earlier schema versions remain top-level, unresolved
comments after migration.

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

## Upstream Backend

An artifact may point at one HTTPS backend. Once a viewer has passed the
artifact gate, requests to the reserved `_api/` path under the artifact URL are
forwarded to that backend, so an interactive artifact can talk to a live
service without running its own login and without shipping a credential in
its HTML.

```http
PATCH /api/v1/artifacts/{artifact_key}
{
  "upstream": {
    "base_url": "https://intake.example.com",
    "secret": "backend bearer token"
  }
}
```

- `base_url` must be `https://` to a public hostname: no IP literals,
  credentials, query, or fragment, and never the artifact host itself.
- The artifact must have a non-public gate. Setting an upstream on a `public`
  artifact, or setting `gate_level` to `public` on an artifact with an
  upstream, is refused; the proxy also answers `403` as a backstop, because a
  public artifact would hand the stored secret to anyone.
- The proxy is rate-limited to 120 requests per minute per viewer and 1200 per
  artifact; excess requests receive `429 upstream_rate_limited` with
  `Retry-After`.
- `secret` is optional and write-only. Setting `upstream` replaces both fields;
  `"upstream": null` removes the backend.
- `GET /api/v1/artifacts/{artifact_key}` returns `upstream: { base_url, path,
has_secret, updated_at }` or `null`. The secret is never returned.

How a proxied request reaches the backend:

```http
GET  {artifact url}_api/api/items?x=1   ->  GET  {base_url}/api/items?x=1
POST {artifact url}_api/api/items       ->  POST {base_url}/api/items
```

- `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` are forwarded; bodies up
  to 10 MiB; 60 s upstream timeout (`504 upstream_timeout`), unreachable
  backend `502 upstream_unreachable`, no backend configured `404 no_upstream`.
- Forwarded request headers: `Accept`, `Accept-Language`, `Content-Type`,
  `If-None-Match`, `If-Modified-Since`, `Range`, plus
  `Authorization: Bearer <secret>` (when set), `X-Artifact-Key`,
  `X-Artifact-Viewer-Email` (the gate email, empty on public artifacts),
  `X-Artifact-Viewer-Verified` (`1`/`0`), `X-Artifact-Viewer-Id`, and
  `X-Forwarded-For`. Cookies and other viewer headers are not forwarded.
- Returned response headers are limited to content and caching metadata
  (`Content-Type`, `Content-Disposition`, `Content-Language`,
  `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Retry-After`,
  `Vary`, `X-Request-Id`); `Cache-Control` is always `private, no-store`. The
  backend's cookies and CORS headers never reach the viewer.
- Without a viewer session the path answers the machine-readable gate (`401`
  JSON) regardless of `Accept`; the page must be opened through the gate first.
