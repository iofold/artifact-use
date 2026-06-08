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
