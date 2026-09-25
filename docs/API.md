# REST API

All creator/admin endpoints require a bearer token — either a WorkOS
OAuth/AuthKit access token or an `au_creator_...` creator token minted from the
admin's Connect page (`/admin/connect`):

```http
Authorization: Bearer <token>
```

Creator tokens expire 90 days after minting by default. An expired token
receives `401` with `error.code` `token_expired` and `error.renew_url` pointing
at `/admin/connect` (a revoked token gets `token_revoked` with the same
`renew_url`); mint a new token there and retry. Every error body has the shape
`{"error": {"code": "...", "message": "..."}}`.

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

Secret scan. `POST /api/v1/publish/html` scans the HTML and the completion step scans every uploaded text-like file (html, js, css, json, txt, md, svg, xml, csv; up to 2 MiB each, 200 files, 20 findings). If credential-like strings are found the publish is refused with `422 {"error":{"code":"secrets_detected","message":…,"findings":[{"path","kind","line","preview"}]}}` and the draft stays writable; send `allow_secrets: true` to publish anyway, in which case the response carries `warnings` with the same findings. Every successful publish response also carries `note`, a reminder that the URL is unlisted but reachable by anyone who has it and passes the gate.

## Viewer Comments

The injected comments popup uses the viewer session cookie from the artifact
gate.

```http
GET /_au/comments?artifact_key={url_key}&status=open|sent|resolved|all&since=<unix>&wait=<1..25>&page_path=<path>&limit=<n>
POST /_au/comments
PATCH /_au/comments
```

`GET` returns `{comments, count, has_more, next_since}`. Each comment carries
`parent_comment_id` (replies), `resolved` / `resolved_at` / `resolved_by`,
`sent_to_agent_at`, `author_kind` (`human` or `agent`), `agent_label`, and
`target` (parsed) next to `target_json`. `status=sent` lists the unresolved
threads a viewer flagged with "Send to agent"; replies follow their root for
every status filter.

Long-poll instead of polling: with `wait` (seconds, at most 25) the request is
held until a comment newer than `since` exists (checked every 2 s) and answers
`[]` with a fresh `next_since` on timeout. Pass `next_since` back as `since`
on the next call. A comment from the boundary second may repeat, so
de-duplicate by `id`; when `has_more` is true `next_since` does not advance,
so re-list with a larger `limit` first.

`POST /_au/comments` creates either a top-level comment or a reply when
`parent_id` is supplied. Include `artifact_key` in the JSON body. An optional
`client_ref` (up to 64 characters, unique per artifact) makes the post
idempotent: a retry with the same `client_ref` after a lost response returns
the comment that was already created. `PATCH /_au/comments` accepts
`artifact_key`, `id`, and one of `resolved` (resolve or reopen), `target`
(re-anchor), or `sent_to_agent` (`true` flags the thread root for the
publishing agent, even when `id` is a reply, and fires the
`comment.sent_to_agent` webhook; `false` clears the flag).

The publisher endpoint `/api/v1/artifacts/{artifact_key}/comments` speaks the
same shapes (`GET` with the same filters including `wait`; `POST` with `body`,
`parent_id`, `page_path`, `target`, `client_ref`; `PATCH` with `id`,
`resolved`). Comments written there, or with a delegated "Hand to your agent"
session on `/_au/comments`, are recorded as `author_kind: "agent"` with the
token's label (`agent_label`), and the widget shows "via agent" on them. Every
creator-side `GET` also records agent presence, which the page shows as
"an agent checked this page N min ago" (`GET /_au/artifact-context` returns
`agent: {watching, last_seen_at, label}`; `watching` is true within 10
minutes).

`page_path` is normalised on write: a trailing `index.html` and trailing slash
are stripped, so `/go/x/`, `/go/x/index.html` and `/go/x` are the one key
`/go/x`; the `page_path` filter accepts any of the three.

`target` (version 3) keeps the earlier fields (`selector`, `label`, `path`,
`text`, `anchors`, `rect`, `version_id`) and adds the element context the
widget captures: `tag`, `caption` (alt, aria-label, title, figcaption or SVG
title), `src` (media file basename), `heading` (the nearest preceding h1–h3),
`index` (nth same-tag sibling), `page_title`, and `viewport` `{w, h, dpr}`.
Comments anchored before this carry `v: 2` targets without the extra fields.

## Webhooks

Push instead of polling: subscribe an HTTPS URL to comment events for one
artifact or for every artifact in the workspace.

```http
POST /api/v1/webhooks
{
  "url": "https://hooks.example.com/artifact-use",
  "artifact": "claims-demo-a1b2c3",
  "events": ["comment.created", "comment.sent_to_agent"],
  "secret": "optional, 8 to 256 characters"
}
GET /api/v1/webhooks
DELETE /api/v1/webhooks/{id}
```

- Events: `comment.created`, `comment.replied`, `comment.resolved`,
  `comment.reopened`, `comment.sent_to_agent`; omitted `events` means all
  five. Omit `artifact` to subscribe the whole workspace. At most 20 active
  webhooks per workspace.
- `POST` and `DELETE` require `artifacts:manage_access` (creator tokens have
  it); `GET` requires `artifacts:read`. The response to `POST` carries the
  `secret` once (generated as `whsec_...` when not supplied); `GET` never
  returns it. `url` follows the upstream-backend rules: `https://` to a
  public hostname, no credentials or fragment (a query string is allowed).
- Delivery is `POST {url}` with `Content-Type: application/json` and the
  headers `X-Artifact-Use-Event: <event>`, `X-Artifact-Use-Delivery: <id>`
  (de-duplicate on it) and `X-Artifact-Use-Signature: sha256=<hex
HMAC-SHA256 of the raw body with the secret>`. Any 2xx within 10 s is a
  success; redirects are not followed.
- The first attempt is made right after the write. Failures are retried
  1 m, 5 m, 30 m, 2 h and 12 h later by the maintenance cron, then dropped.
  `GET` shows `pending`, `last_delivery_at` and `last_status` per webhook.

Payload:

```json
{
  "event": "comment.replied",
  "artifact": {
    "id": "art_...",
    "url_key": "claims-demo-a1b2c3",
    "url": "https://artifacts.iofold.com/go/claims-demo-a1b2c3/",
    "title": "Claims Demo"
  },
  "comment": { "id": 43, "parent_comment_id": 42, "body": "...", "...": "..." },
  "thread": {
    "id": 42,
    "parent_comment_id": null,
    "body": "...",
    "...": "..."
  },
  "occurred_at": 1758800000
}
```

`comment` is the comment the event is about and `thread` its root (the same
object for a root comment); both use the comment shape above.

## Admin

```http
GET /api/v1/me
GET /api/v1/workspaces
GET /api/v1/artifacts
GET /api/v1/artifacts/{artifact_key}
PATCH /api/v1/artifacts/{artifact_key}
GET /api/v1/artifacts/{artifact_key}/stats
POST /api/v1/artifacts/{artifact_key}/share-links
GET /api/v1/artifacts/{artifact_key}/share-links
DELETE /api/v1/artifacts/{artifact_key}/share-links/{link_id}
GET /api/v1/artifacts/{artifact_key}/comments
POST /api/v1/webhooks
GET /api/v1/webhooks
DELETE /api/v1/webhooks/{id}
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

Gate levels (`gate_level` on publish and on `PATCH`):

- `public`: anyone with the link; no view is recorded.
- `email`: the viewer types an email and is let in. The address is
  syntax-checked and its domain must publish an MX or A record (checked over
  DNS-over-HTTPS, fail-open on resolver errors), but it is never verified;
  the admin labels these views "self-reported".
- `verified_email`: the "share with a client" preset. A one-time code proves
  the inbox, so every view is attributable.
- `allowlist`: `verified_email` restricted to listed addresses and domains.

`PATCH` also accepts `access_preset` as a friendlier alias for the same four
levels: `open`, `email`, `client` (= `verified_email`), `restricted`
(= `allowlist`). No other levels exist.

Every artifact URL is unlisted: responses carry `X-Robots-Tag: noindex,
nofollow`, so only people holding the URL (or a share link) can find it.

### Reading as the publisher

A request carrying a creator token (or MCP OAuth token) of the artifact's
workspace passes the gate for reads — `GET`/`HEAD` of pages, assets and the
`_au/index.json` descriptor — with no viewer session and no view row. An
agent can fetch the URL it just published with the token it already holds;
the gate dance is only for viewers outside the workspace. The upstream `_api/`
proxy still needs a viewer session, because the backend expects a viewer
identity.

### Share links

A share link passes the artifact's gate on the publisher's say-so, at every
gate level, until it expires, is revoked, or reaches its open limit. Every
open (one per viewer session, never per asset) increments `open_count` and
`last_opened_at`. The viewer opens `{artifact url}?v={link_id}`.

```http
POST /api/v1/artifacts/{artifact_key}/share-links
{
  "kind": "password",
  "label": "Board deck",
  "expires_days": 7,
  "max_opens": 3
}
```

Fields: `kind` (`recipient` default, `password`, `open`), `label`,
`recipient_email` and `recipient_label` (recipient links), `passcode` (password
links only; 6–72 characters, generated when omitted), `expires_days` (1–365),
`max_opens` (1–100000).

- `recipient`: the URL itself is the credential for one named person. Views
  are attributed to `recipient_email` (unverified) or, without one, to
  `link:{id}`.
- `password`: the viewer types a passcode; no email is asked. Views are
  recorded as `link:{id}`. The passcode is hashed (PBKDF2-SHA256, per-link
  salt) and returned exactly once, in the creation response.
- `open`: anyone holding the unguessable id passes. Views are `link:{id}`.

The response is the link object plus, for password links, `passcode`:

```json
{
  "id": "3f9c1b2e8a7d4c50",
  "kind": "password",
  "label": "Board deck",
  "recipient_email": null,
  "recipient_label": null,
  "url": "https://artifacts.iofold.com/go/board-deck-a1b2c3/?v=3f9c1b2e8a7d4c50",
  "state": "active",
  "expires_at": 1760000000,
  "revoked_at": null,
  "max_opens": 3,
  "open_count": 0,
  "last_opened_at": null,
  "view_count": 0,
  "created_at": 1759400000,
  "passcode": "kf7m-2pqx-9dn4",
  "note": "Share the url and the passcode separately; ..."
}
```

`GET .../share-links` returns `{"links": [...]}` with the same objects
(`state` is `active`, `expired`, `revoked` or `exhausted`; never a passcode).
`DELETE .../share-links/{link_id}` revokes and returns
`{"ok": true, "id", "state": "revoked"}`; sessions minted through that link
stop working immediately. Creating, listing and revoking all require
`artifacts:manage_access`.

How a viewer or agent passes a link:

- `recipient` and `open`: a browser `GET` with `?v=` is redirected to the
  same URL without the id, with the viewer cookie set; a non-browser `GET`
  (`Accept` without `text/html`) is served inline with the cookie attached.
- `password`: browsers get a passcode form; non-browser clients get `401`
  with `link_kind: "password"` and `link_id`. Exchange the passcode for a
  bearer token with `POST /_au/gate/link` (form fields `artifact_key`,
  `link`, `passcode`; `Accept: application/json`), or send
  `Authorization: Basic base64("{link_id}:{passcode}")` on the artifact URL
  (a view is recorded per request without the bearer). Ten wrong guesses per
  link and IP in 15 minutes answer `429`.
- Expired, revoked or exhausted links answer `410` with `error.code`
  `link_expired`, `link_revoked` or `link_exhausted` (and a plain page for
  browsers).

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
