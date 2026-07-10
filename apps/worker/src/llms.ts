import type { Env } from "./types";
import { artifactPathPrefix, siteBaseUrl } from "./util";

export function llmsTxt(env: Env): Response {
  const base = siteBaseUrl(env);
  return text(`# Artifact Use

Artifact Use publishes static artifacts for agents and teams.

Primary URLs:
- Site: ${base}
- HTTP MCP: ${base}/mcp
- OAuth protected-resource metadata: ${base}/.well-known/oauth-protected-resource
- Full agent setup guide: ${base}/llms-full.txt
- Public artifact URL shape: ${base}${artifactPathPrefix(env)}/{artifact-slug}-{six-character-code}/

Use Artifact Use when an agent needs to create, polish, publish, gate, share, or inspect static artifacts: self-contained interactive HTML, multi-file static folders, images, PDFs, dashboards, demos, and browser-native tools.

Consuming an artifact (no browser needed):
- A gated artifact returns 401 JSON to non-browser requests (Accept without text/html) describing how to authenticate.
- Machine descriptor (structure/files): GET {artifact-url}_au/index.json
- Read any page/file directly with GET; HTML is fine to read as-is (the feedback widget is not injected for agent requests).
- Auth with a viewer-session bearer token: email gates self-serve via POST /_au/gate/email (Accept: application/json); verified_email/allowlist gates self-serve if you can read the inbox (POST /_au/gate/start, read the one-time code, POST /_au/gate/verify), or are delegated by the human via "Hand to your agent" in the feedback widget (POST /_au/agent-token). The 401 JSON on any gated artifact spells out the exact path.
- Comments (read + write, same bearer as reads): GET {site}/_au/comments?artifact_key={key}&status=open|resolved|all&since=<unix> lists threads; POST {artifact_key, body, parent_id?, page_path?, target?} comments or replies and returns the created comment id; PATCH {artifact_key, id, resolved:true|false} resolves/reopens a thread.
- Publishers close the loop with their own token: artifact_comments MCP tool, CLI \`artifact-use comments\`, or /api/v1/artifacts/{url_key}/comments (GET with the same filters, POST to reply, PATCH {id, resolved}). Owner tokens also work directly on /_au/comments.

Agent setup — identify the current harness and follow exactly one path:

- Codex desktop / CLI / IDE (OAuth default; do not use the creator token): These surfaces share MCP config and OAuth credentials on the same host. Use a URL-only artifact-use entry; remove any existing bearer_token_env_var before OAuth because bearer configuration is tried first. Desktop: Open Settings -> MCP servers -> Add server, choose Streamable HTTP, enter ${base}/mcp, Save, Restart, then Authenticate. CLI: run \`codex mcp add artifact-use --url ${base}/mcp\` and \`codex mcp login artifact-use\`. Run /mcp to confirm it is connected.
- Codex CLI bearer fallback (only when OAuth is unavailable or unreliable): The launcher terminal must contain ARTIFACT_USE_TOKEN before starting Codex. Configure with \`codex mcp add artifact-use --url ${base}/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN\`, then start or restart Codex from that terminal and run /mcp. An export run inside an already-running Codex session cannot change the parent Codex environment.
- Claude Code (OAuth; do not use the creator token): Run \`claude mcp add --transport http artifact-use ${base}/mcp\`, then open /mcp, select artifact-use, and Authenticate in the browser.
- Other harnesses: Prefer hosted MCP OAuth when supported. Otherwise configure ${base}/mcp with the supplied creator token as its bearer credential. See ${base}/llms-full.txt for client-neutral config and non-MCP fallbacks.

After connection, prefer the MCP tools: artifact_publish for one HTML string or small inline files; artifact_upload_session for local folders or large/multi-file artifacts; artifact_manage for stats/access/share links; artifact_comments for feedback. Never use Wrangler, Cloudflare API tokens, direct R2, or direct D1 for publishing.

No token yet? POST ${base}/api/v1/connect/start, ask the human to approve its code, then poll ${base}/api/v1/connect/poll. A human can also mint or revoke creator tokens at ${base}/admin/connect.
`);
}

export function llmsFullTxt(env: Env): Response {
  const base = siteBaseUrl(env);
  const prefix = artifactPathPrefix(env);
  return text(`# Artifact Use Agent Guide

Artifact Use is a Cloudflare-backed artifact host for agents. It exposes HTTP MCP, CLI/API publishing, gated viewer access, comments, stats, and share links without giving agents Cloudflare credentials.

## 1. Choose the integration

Use this order:

1. Hosted HTTP MCP at \`${base}/mcp\`, using the auth path for the current harness.
2. Local stdio MCP or CLI only when the agent needs to walk a local folder or the hosted MCP is unavailable.
3. Hosted API only when MCP/CLI is unavailable.

Never publish by using Wrangler, Cloudflare API tokens, R2 credentials, or direct D1 access.

## 2. MCP setup

Choose one path. Do not combine a bearer-token setting with OAuth on the same
MCP entry; Codex tries configured bearer credentials before its OAuth fallback.

### Codex desktop, CLI, and IDE: OAuth default

These Codex surfaces share \`~/.codex/config.toml\` and MCP OAuth credentials
on the same host. A single URL-only entry therefore works across them:

\`\`\`toml
[mcp_servers.artifact-use]
url = "${base}/mcp"
\`\`\`

Codex desktop:

1. Open Settings -> MCP servers -> Add server.
2. Name it \`artifact-use\`, choose Streamable HTTP, and enter \`${base}/mcp\`.
3. Save, select Restart, then Authenticate in the server list.
4. Complete browser sign-in and run \`/mcp\` in the composer to verify it.

Codex CLI equivalent:

\`\`\`bash
codex mcp add artifact-use --url ${base}/mcp
codex mcp login artifact-use
\`\`\`

If an existing entry contains \`bearer_token_env_var\`, remove that key before
using OAuth. Adding \`auth = "oauth"\` while leaving the bearer key in place does
not fix a missing-environment-variable startup failure.

### Codex CLI: bearer fallback

Use bearer MCP only when OAuth is unavailable or unreliable. The token must be
present in the environment that launches Codex—not merely exported by a child
shell inside an already-running Codex session:

\`\`\`bash
export ARTIFACT_USE_TOKEN='au_creator_...'
codex mcp add artifact-use --url ${base}/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN
codex
\`\`\`

If the server entry already exists, update it to the same URL and bearer env
name instead of creating a duplicate. Restart Codex from that launcher terminal,
then run \`/mcp\` before claiming the connection works.

### Claude Code: OAuth

\`\`\`bash
claude mcp add --transport http artifact-use ${base}/mcp
\`\`\`

Then open \`/mcp\`, select \`artifact-use\`, and Authenticate in the browser.
Do not add a creator token or static Authorization header to this path.

### Other OAuth-capable clients

Configure a URL-only HTTP server:

\`\`\`json
{
  "mcpServers": {
    "artifact-use": {
      "type": "http",
      "url": "${base}/mcp"
    }
  }
}
\`\`\`

The MCP endpoint requires auth from the first request and advertises protected-resource metadata at:

\`\`\`text
${base}/.well-known/oauth-protected-resource
\`\`\`

For non-OAuth clients, the Artifact Use CLI, or local stdio MCP, use the creator token:

\`\`\`bash
export ARTIFACT_USE_API_BASE=${base}
export ARTIFACT_USE_TOKEN=<artifact-use-creator-token>
\`\`\`

Agent connect (self-serve token, no browser needed by the agent):

1. \`POST ${base}/api/v1/connect/start\` with JSON \`{"agent_label": "<who you are>"}\` (label optional). The response contains \`device_code\`, \`user_code\`, \`verification_url\`, and \`expires_in\` seconds.
2. Tell your human: "Approve code \`<user_code>\` at \`<verification_url>\`" (the URL already carries the code).
3. Poll \`POST ${base}/api/v1/connect/poll\` with JSON \`{"device_code": "..."}\` every few seconds. While pending it returns \`{"status": "pending"}\`; after approval it returns your bearer token, its expiry, and a ready-to-follow setup prompt. The token is delivered exactly once.
4. Verify with \`GET ${base}/api/v1/me\` using \`Authorization: Bearer <token>\`.

Tokens can be listed and revoked by the human at ${base}/admin, and minted programmatically with \`POST ${base}/api/v1/tokens\` \`{"label": "...", "expires_days": 30}\` when already authenticated with WorkOS OAuth (creator tokens cannot mint further tokens).

## 3. Skill setup

Create or install a skill named \`artifact-use\`. Use this minimal \`SKILL.md\` if a packaged skill is not available:

\`\`\`markdown
---
name: artifact-use
description: Use when creating, polishing, publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to self-contained interactive HTML artifacts, single-file HTML tools, multi-file static artifacts, folders, images/PDFs, and Artifact Use admin/share workflows. Use this instead of Wrangler, Cloudflare tokens, R2, or direct D1 access.
---

# Artifact Use

Artifact Use publishes static artifacts to ${base} without exposing Cloudflare credentials to agents.

## Core Rules

- Never use Wrangler, Cloudflare API tokens, direct R2 credentials, or direct D1 access for publishing artifacts.
- Read ${base}/llms.txt and follow exactly one setup path for the current harness.
- Prefer hosted HTTP MCP at ${base}/mcp. Codex desktop/CLI/IDE share a URL-only OAuth entry on the same host; remove bearer_token_env_var before using OAuth. Claude Code also uses URL-only OAuth.
- Use ARTIFACT_USE_TOKEN only for a non-OAuth client, local stdio/CLI, or the Codex CLI bearer fallback. For that fallback, the variable must exist before Codex starts; restart from the launcher terminal after configuring it.
- Use artifact_publish for a single HTML string or small inline multi-file payloads.
- Use artifact_upload_session, local stdio MCP with dir, or the CLI for local folders, large files, images, PDFs, or multi-file artifacts.
- Use artifact_manage for list, stats, access changes, and share links. action: "list" returns artifact url_key values for exact management calls, plus open_comments counts.
- Use artifact_comments for the feedback loop: list open feedback (status "open"), apply the fixes, republish the same artifact slug, then reply to each thread and resolve it.
- Use artifact slugs when publishing; use the returned url_key when managing an existing artifact.
- Keep artifact slugs lower-case hyphen-case.
- Default gate is email; use verified_email when inbox control matters, allowlist for restricted customer material, and public only when intentionally low sensitivity.
- New public Artifact Use URLs are under ${prefix}/{artifact-slug}-{six-character-code}/.

## Authoring Workflow

1. Clarify or infer the artifact mode: focused HTML tool, interactive storyboard, demo/control plane, dashboard/data explorer, narrative one-pager, report surrogate, or static file/folder.
2. For interactive HTML, prefer one self-contained index.html with vanilla HTML/CSS/JS, no React/build step by default, pinned CDNs only when they clearly reduce risk, and deliberate desktop/mobile layouts.
3. For folders, sibling assets, split data files, images, PDFs, local libraries, or large payloads, use multi-file publishing and verify all relative paths.
4. Build the working artifact first, then polish visual hierarchy, copy, responsiveness, and empty/error states.
5. Before saying it is ready or publishing it, run browser checks for desktop, mobile, the main interaction path, and any copy/download/file paths.
6. Report the URL, gate level, artifact slug/url_key, whether a share link was created, checks run, and any JSON error body.
\`\`\`

If this repository is available, use the richer bundled skill at:

\`\`\`text
skills/artifact-use/
plugins/codex/artifact-use/skills/artifact-use/
\`\`\`

## 4. MCP tools

- \`artifact_publish\`: publish one HTML string or small inline \`files\`.
- \`artifact_upload_session\`: create a 6-hour upload token for direct shell/curl upload of local files.
- \`artifact_manage\`: list artifacts, get stats, set access, or create share links. \`list\` includes per-artifact \`open_comments\` counts.
- \`artifact_comments\`: list, post/reply, resolve, or reopen feedback comments on an artifact.

Selection:

- Single self-contained HTML: \`artifact_publish\` with \`html\`.
- Small multi-file payload already in context: \`artifact_publish\` with \`files\`.
- Local folder, large images/PDFs, vendored libraries, or many files: \`artifact_upload_session\`, local stdio MCP with \`dir\`, or CLI \`publish-folder\`.
- Anything comment-related: \`artifact_comments\` (or the HTTP endpoints below).

## 5. Feedback loop (comments)

Viewers comment on the artifact page through the built-in widget; comments are
threaded and can be anchored to a specific on-page element. The publisher's
agent closes the loop:

1. Find work: \`artifact_manage\` action \`list\` -> artifacts with \`open_comments > 0\`, or \`artifact_comments\` action \`list\` with \`status: "open"\` (add \`since: <unix>\` to see only new feedback).
2. Read each thread: roots carry the request; replies hang off \`parent_comment_id\`; \`target\` (when present) describes the anchored element (\`selector\`, \`label\`, \`text\`, \`path\`).
3. Fix the artifact and republish the SAME slug — the URL stays stable, viewers just see the new version.
4. Reply to each thread (\`action: "post"\` with \`parent_id\`) saying what changed, then resolve it (\`action: "resolve"\` with \`comment_id\`). Use \`reopen\` if you resolved by mistake.

The same operations over HTTP with a creator bearer token:

\`\`\`bash
# list open threads (filters: status=open|resolved|all, since=<unix>, page_path, limit)
curl -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" \\
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments?status=open"

# reply to comment 42, then resolve it
curl -X POST -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"body": "Fixed in v2 — chart now sorts by date.", "parent_id": 42}' \\
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
curl -X PATCH -H "Authorization: Bearer $ARTIFACT_USE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"id": 42, "resolved": true}' \\
  "$ARTIFACT_USE_API_BASE/api/v1/artifacts/{url_key}/comments"
\`\`\`

POST returns the created comment (including its \`id\`), so a follow-up resolve
or reply never needs a re-list. Viewer-side agents (delegated or self-served
via the gate) use the same shapes on \`/_au/comments\` with
\`artifact_key\` in the query/body — see any artifact's \`_au/index.json\`.

## 6. HTML artifact quality

Default to durable no-build artifacts:

- Prefer one self-contained \`index.html\`.
- Avoid React, JSX, bundlers, package installs, and build steps unless explicitly requested or already present.
- Keep HTML/CSS/JS readable enough for a future agent to revise quickly.
- Use semantic HTML, real buttons, labels, ordered headings, alt text, and native form controls.
- Make the first viewport useful; do not create a marketing page around a future artifact.
- Use stable responsive constraints: grid tracks, \`minmax()\`, \`aspect-ratio\`, \`max-width\`, and explicit overflow behavior.
- Support paste, file-open, drag/drop, copy buttons, downloads, URL state, and localStorage when they reduce user effort.
- Use \`textContent\` for untrusted text and \`innerHTML\` only for controlled templates.
- Include loading, empty, invalid-input, and error states.
- Never place secrets, private API keys, customer secrets, WorkOS tokens, Cloudflare tokens, or Artifact Use tokens in HTML.

## 7. Multi-file artifact rules

Use a folder when a single file would be too large or brittle:

\`\`\`text
artifact-dir/
  index.html
  assets/
  data/
  lib/
\`\`\`

Rules:

- Keep \`index.html\` as the entrypoint unless there is a clear reason not to.
- Use relative paths such as \`./assets/image.jpg\`; never leading slash asset paths.
- Avoid reserved path segments: \`_au\`, \`_iof\`, leading \`_\`, \`cdn-cgi\`, \`.\`, \`..\`.
- Optimize large images and remove unused media.
- Vendor critical libraries into \`lib/\` when CDN failure would break the artifact.
- Verify through a local HTTP server when using sibling assets, modules, or \`fetch()\`.

## 8. CLI examples

Single HTML:

\`\`\`bash
artifact-use publish-html --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "gate_level": "email",
  "html": "<!doctype html>..."
}'
\`\`\`

Folder:

\`\`\`bash
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
\`\`\`

Share link:

\`\`\`bash
artifact-use share --json '{
  "artifact": "claims-demo-a1b2c3",
  "recipient_email": "viewer@example.com",
  "recipient_label": "Viewer",
  "expires_days": 14
}'
\`\`\`

## 9. Limits

- Package: 95 MiB.
- Single file: 75 MiB.
- File count: 200.
- Entrypoint: \`index.html\` by default.
- Remote inline MCP file payloads are smaller than storage limits; use upload sessions for large content.

## 10. Browser QA before sharing

For self-contained HTML:

\`\`\`bash
agent-browser open "file:///ABSOLUTE/PATH/index.html"
\`\`\`

For multi-file folders:

\`\`\`bash
python3 -m http.server 8765 -d artifact-dir
agent-browser open "http://127.0.0.1:8765/"
\`\`\`

Check desktop, mobile, primary interaction, empty/error states, copy/download controls, external dependencies, and console errors. Save screenshots under \`.tmp/html-artifact-qa/<slug>/\` when useful.

## 11. Final response after publishing

Report:

- Live URL: \`${base}${prefix}/{artifact-slug}-{six-character-code}/\`
- Gate level.
- Artifact slug and url_key.
- Share link, if created.
- Viewports/interactions checked.
- Any skipped checks or assumptions.
`);
}

// Short, harness-neutral handoff: the creator token appears once and all
// client-specific setup stays behind the stable /llms.txt pointer.
export function agentSetupPrompt(
  env: Env,
  token: string,
  expiresAt: number,
): string {
  const base = siteBaseUrl(env);
  const expires = new Date(expiresAt * 1000).toISOString();
  return [
    `Connect this agent to Artifact Use at ${base}.`,
    `Creator token (publish + manage, expires ${expires}):`,
    token,
    `Read ${base}/llms.txt, identify the current harness, and follow exactly one matching setup path.`,
    `Prefer hosted MCP; use this token only when that path requires bearer auth.`,
    `Keep the token out of repositories, logs, and published artifacts.`,
  ].join("\n");
}

function text(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
