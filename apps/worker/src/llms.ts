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
- Leave feedback: POST {artifact-url-or-site}/_au/comments {artifact_key, body, page_path, target?} with the same bearer.

Agent setup summary:
1. Prefer HTTP MCP at ${base}/mcp. OAuth-capable clients should configure only the URL and use the MCP auth prompt.
2. For non-OAuth clients, CLI, or local stdio MCP, set ARTIFACT_USE_API_BASE=${base} and ARTIFACT_USE_TOKEN=<workos-oauth-token>.
3. Install or create a skill named artifact-use using the guidance in ${base}/llms-full.txt.
4. Use artifact_publish for one HTML string or small inline files.
5. Use artifact_upload_session, local stdio MCP, or CLI publish-folder for local folders and large/multi-file artifacts.
6. Do not use Wrangler, Cloudflare API tokens, direct R2, or direct D1 for publishing artifacts.
`);
}

export function llmsFullTxt(env: Env): Response {
  const base = siteBaseUrl(env);
  const prefix = artifactPathPrefix(env);
  return text(`# Artifact Use Agent Guide

Artifact Use is a Cloudflare-backed artifact host for agents. It exposes HTTP MCP, CLI/API publishing, gated viewer access, comments, stats, and share links without giving agents Cloudflare credentials.

## 1. Choose the integration

Use this order:

1. HTTP MCP at \`${base}/mcp\` for OAuth-capable agents.
2. Local stdio MCP or CLI when the agent needs to walk a local folder.
3. Hosted API only when MCP/CLI is unavailable.

Never publish by using Wrangler, Cloudflare API tokens, R2 credentials, or direct D1 access.

## 2. MCP setup

For OAuth-capable clients, configure:

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

For OAuth-capable clients such as Codex, configure only the MCP URL. Do not add
an \`Authorization\` header unless you are deliberately bypassing OAuth with a
fresh bearer token; a stale or placeholder bearer value can force an
\`invalid_token\` path instead of the normal OAuth login flow.

Codex currently loads HTTP MCP auth state into the running process. After
running \`codex mcp login artifact-use\` from another shell, restart the active
Codex session before expecting \`mcp__artifact_use\` calls to see the new token.
If the deployment host changes, remove credentials for the old MCP resource
before logging in again so the OAuth \`resource\` / token \`aud\` value matches:

\`\`\`bash
codex mcp get artifact-use
codex mcp logout artifact-use
codex mcp login artifact-use --scopes openid,profile,email,offline_access
\`\`\`

If logout cannot delete keyring-backed tokens, remove only the \`artifact-use\`
records from \`~/.codex/.credentials.json\`, then log in and restart Codex.

For non-OAuth clients, CLI, or local stdio MCP:

\`\`\`bash
export ARTIFACT_USE_API_BASE=${base}
export ARTIFACT_USE_TOKEN=<workos-oauth-token>
\`\`\`

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
- Prefer hosted HTTP MCP at ${base}/mcp; OAuth-capable clients should authenticate through the MCP prompt.
- For OAuth-capable clients, configure only the MCP URL. Do not add an Authorization header unless you are intentionally passing a fresh bearer token.
- After codex mcp login artifact-use, restart the active Codex session before using mcp__artifact_use; Codex may keep the old HTTP MCP auth state in memory.
- Use ARTIFACT_USE_TOKEN only for CLI, local stdio MCP, or non-OAuth clients.
- Use artifact_publish for a single HTML string or small inline multi-file payloads.
- Use artifact_upload_session, local stdio MCP with dir, or the CLI for local folders, large files, images, PDFs, or multi-file artifacts.
- Use artifact_manage for list, stats, access changes, and share links. action: "list" returns artifact url_key values for exact management calls.
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
- \`artifact_manage\`: list artifacts, get stats, set access, or create share links.

Selection:

- Single self-contained HTML: \`artifact_publish\` with \`html\`.
- Small multi-file payload already in context: \`artifact_publish\` with \`files\`.
- Local folder, large images/PDFs, vendored libraries, or many files: \`artifact_upload_session\`, local stdio MCP with \`dir\`, or CLI \`publish-folder\`.

## 5. HTML artifact quality

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

## 6. Multi-file artifact rules

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

## 7. CLI examples

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

## 8. Limits

- Package: 95 MiB.
- Single file: 75 MiB.
- File count: 200.
- Entrypoint: \`index.html\` by default.
- Remote inline MCP file payloads are smaller than storage limits; use upload sessions for large content.

## 9. Browser QA before sharing

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

## 10. Final response after publishing

Report:

- Live URL: \`${base}${prefix}/{artifact-slug}-{six-character-code}/\`
- Gate level.
- Artifact slug and url_key.
- Share link, if created.
- Viewports/interactions checked.
- Any skipped checks or assumptions.
`);
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
