# REST API

All creator/admin endpoints require a WorkOS OAuth/AuthKit bearer token:

```http
Authorization: Bearer <token>
```

The hosted API defaults to:

```text
https://art-use.iofold.com
```

## OAuth Metadata

```http
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-authorization-server
```

The OAuth protected resource is the hosted MCP endpoint:

```text
https://art-use.iofold.com/mcp
```

## MCP

```http
GET /mcp
POST /mcp
```

Both `GET /mcp` and `POST /mcp` require creator auth. Unauthenticated requests return `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge so OAuth-capable MCP clients can discover WorkOS/AuthKit and prompt sign-in before tool discovery.

Tools:

- `artifact_publish`
- `artifact_manage`

`artifact_publish` accepts either `html` for a single-file artifact or `files` for small HTTP MCP multi-file artifacts. `tenant` is optional; omit it to use the authenticated account's default tenant. Each inline file can contain `content` or `content_base64`. Large folders should use the local stdio MCP or CLI so file bytes move directly from disk to the hosted API without entering model context.

## Tenant

```http
POST /api/v1/tenants
{
  "tenant": "acme",
  "name": "Acme"
}
```

## Publish HTML

```http
POST /api/v1/publish/html
{
  "tenant": "acme",
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "html": "<!doctype html>..."
}
```

`tenant` may be omitted; the server will use or create the authenticated account's default tenant.

## Publish Folder

Start:

```http
POST /api/v1/publish/start
{
  "tenant": "acme",
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "entrypoint": "index.html"
}
```

`tenant` may be omitted; the server will use or create the authenticated account's default tenant.

Upload each file:

```http
PUT /api/v1/publish/{version_id}/files/index.html
Content-Type: text/html; charset=utf-8
X-Artifact-Sha256: ...
```

Complete:

```http
POST /api/v1/publish/{version_id}/complete
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

## Admin

```http
GET /api/v1/artifacts
GET /api/v1/artifacts/{tenant}/{artifact}
PATCH /api/v1/artifacts/{tenant}/{artifact}
GET /api/v1/artifacts/{tenant}/{artifact}/stats
POST /api/v1/artifacts/{tenant}/{artifact}/share-links
GET /api/v1/artifacts/{tenant}/{artifact}/comments
```

Gate levels:

- `public`
- `email`
- `verified_email`
- `allowlist`
