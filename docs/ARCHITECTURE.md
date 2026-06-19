# Architecture

## Core Flow

```text
agent / CLI / MCP
  -> WorkOS OAuth bearer token
  -> Artifact Use REST API
  -> Cloudflare Worker
  -> D1 metadata + R2 static files
  -> stable public artifact URL
```

Cloudflare remains the hosting backend, but Cloudflare API credentials are not distributed to agents.
The Worker owns R2 writes through its binding.

## Ownership

Creators authenticate with WorkOS. The Worker expects a JWT with an organization identifier and permissions or OAuth scopes.
Read/write authorization is configurable, so a hosted deployment can start with WorkOS `openid` scopes and later tighten to dedicated `artifacts:*` scopes.
Artifacts are owned by WorkOS organization IDs. `created_by` must be a WorkOS `user_...` id.

Public artifact URLs use the `/go` prefix followed by an artifact slug and six-character code from the artifact id:

```text
/go/{artifact_slug}-{code}/
/go/{artifact_slug}-{code}/assets/app.js
```

R2 object keys use immutable IDs:

```text
orgs/{org_id}/artifacts/{artifact_id}/versions/{version_id}/files/{path}
```

## Versioning

Every publish creates a draft row in `artifact_versions`.
Files upload into that draft.
`complete` validates file existence and flips `artifacts.current_version_id`.
Readers never see partial uploads.

## Folder Artifacts

A folder artifact is a static website with an `index.html` entrypoint and related assets.
The manifest lists every path, content type, size, and SHA-256 hash.

HTTP MCP can publish small multi-file artifacts through inline file payloads.
Large local folders should use the CLI or local stdio MCP, because a remote HTTP MCP server cannot inspect a client's filesystem.

Recommended v1 limits:

- 95 MiB per package.
- 75 MiB per file.
- 200 files.
- 512 characters per path.

## Gates

Viewer gates are intentionally DocSend-style:

- `public`: no gate.
- `email`: self-asserted email.
- `verified_email`: one email contains both a magic link and an OTP code.
- `allowlist`: email/domain allowlist plus verified email.

Future SSO gates can be added without changing creator auth.
