# Architecture

## Core Flow

```text
agent / CLI / MCP
  -> WorkOS OAuth bearer token or au_creator_ creator token
  -> Artifact Use REST API
  -> Cloudflare Worker
  -> D1 metadata + R2 static files
  -> Browser Rendering + R2-cached social preview images
  -> stable public artifact URL
```

Cloudflare remains the hosting backend, but Cloudflare API credentials are not distributed to agents.
The Worker owns R2 writes through its binding.

## Ownership

Creators authenticate with WorkOS, or with an `au_creator_` token minted from a WorkOS session at `/admin/connect`. For WorkOS tokens the Worker expects a JWT with an organization identifier and permissions or OAuth scopes.
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
A version may carry a one-line `change_note` from the publishing agent, which version history shows instead of a diff.
Prior versions are served under `_v/{version_id}/` to the publishing workspace only; viewers always get the current version.

## Public Preview Envelope

Public artifacts expose title and description metadata. Protected artifacts use generic metadata without title, description, version, or file type. The Worker injects Open Graph, X card, canonical, and artifact-favicon tags at the start of HTML heads. Known link-preview crawlers receive a small metadata document for every artifact type; they never receive gated artifact bytes, viewer sessions, tracked-share recipients, or share capability IDs.

Preview images are deterministic 1200×630 proof sheets rendered through the `BROWSER` binding and cached in R2 under a versioned metadata revision. Only public cards render title, description, and entrypoint type. Protected cards use generic copy and are not publicly cached.

## Folder Artifacts

A folder artifact is a static website with an `index.html` entrypoint and related assets.
The manifest lists every path, content type, size, and SHA-256 hash.

HTTP MCP can publish small multi-file artifacts through inline file payloads.
Large or multi-file uploads default to `artifact_upload_session`: the tool returns a short-lived upload token and the agent `PUT`s each file straight to the Worker, so bytes never pass through MCP. The CLI and local stdio MCP remain for harnesses that cannot make those HTTP calls, because a remote HTTP MCP server cannot inspect a client's filesystem.

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

## Upstream Proxy

An artifact may name one HTTPS backend (`artifact_upstreams`, one row per
artifact). The reserved `_api/` path under the artifact URL forwards to it
after the gate check in `servePublic`, so the backend inherits the artifact's
viewer gate instead of running its own login: the Worker attaches the stored
bearer secret and the viewer's gate identity (`X-Artifact-Viewer-Email`), the
published HTML holds no credential, and the backend only ever sees requests
from viewers who passed the gate. On `allowlist` artifacts every proxied
request re-checks the current allowlist against the session's email. Request
and response headers are allowlisted, upstream cookies are dropped, and
proxied responses are never cached. Upstream URLs are limited to public hostnames over HTTPS; the secret is
write-only through the API.

## Browser isolation and current grants

Stable links remain on `SITE_BASE_URL`. Interactive documents run on a dedicated
`a-<artifact-id>.<ARTIFACT_HOST_SUFFIX>` origin. The trusted origin keeps publisher
auth, Google callbacks, admin, REST, and MCP. Agent reads through stable links
still receive original bytes, with a restrictive browser sandbox CSP.
Without the suffix, uploaded pages are served inert under that sandbox unless
the deployment sets `ARTIFACT_SHARED_ORIGIN = "true"`, which runs them on
`SITE_BASE_URL` as before isolation existed: uploaded scripts are then
same-origin with the admin (see `docs/DEPLOY.md`).

The destination establishes independent signed state for each navigation. The
trusted origin then issues a single-use, 60-second database ticket bound to its
nonce hash and artifact. A different browser cannot redeem it. Authentication
cookies use the browser-enforced `__Host-` prefix, Secure and Path=/, without
Domain. Artifact hosts accept only their own files and viewer endpoints;
cookies, localStorage and service workers are isolated. Browser mutations check
Origin; Origin-less agent HTTP calls remain supported.

Protected file and upstream responses also set
`Cross-Origin-Resource-Policy: same-origin`. Separate origins alone do not block
classic cross-origin script/resource inclusion with ambient browser cookies.
The resource policy prevents another artifact from embedding private assets;
own-origin assets and public shared resources remain usable. JSON responses
carry the same resource policy and `X-Content-Type-Options: nosniff`.

Workspace grants carry a user id checked against current membership. The
five-minute membership cache expires closed during directory outages. Long-poll
comment reads reauthorize before returning. Protected files use
`private, no-store`, including assets with content hashes.
