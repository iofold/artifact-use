---
name: artifact-use
description: Use when the user asks to publish, share, review, gate, get a link for, or check stats on agent output (self-contained HTML tools, dashboards, static folders, images, PDFs) through Artifact Use, or to read and resolve reviewer comments on a published artifact. Covers the hosted MCP tools, CLI, and HTTP API. Use this instead of Wrangler, Cloudflare tokens, R2, or direct D1 access.
license: MIT
---

# Artifact Use

Artifact Use publishes static artifacts to `https://artifacts.iofold.com` without exposing Cloudflare credentials to agents. The canonical guide is `https://artifacts.iofold.com/llms-full.txt` (source: `docs/agent-guide.md` in the repository); this skill is the short form and defers to it.

## Core Rules

- Artifact Use never publishes unless you call a publish tool. Publish only when the user asks for a link, a share, a review, or a republish; reading, listing, stats, and comments change nothing.
- Prefer republishing the existing artifact: pass its `url_key` (from the previous publish result or `artifact_manage` `list`) as `artifact`. A slug you published before also republishes in place. Never guess a `url_key`.
- Never use Wrangler, Cloudflare API tokens, direct R2 credentials, or direct D1 access for publishing.
- Connect over hosted HTTP MCP at `https://artifacts.iofold.com/mcp` with exactly one auth path: OAuth in Claude Code (`claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp`, then `/mcp` → Authenticate) and in Codex desktop/CLI/IDE (`codex mcp add artifact-use --url https://artifacts.iofold.com/mcp`, `codex mcp login artifact-use`; remove any `bearer_token_env_var` first), or a creator token everywhere else. Details and the Codex bearer fallback are in `references/publishing.md`.
- No token and no OAuth? Ask the user to open `https://artifacts.iofold.com/admin/connect`, copy the setup prompt, and paste it to you. Tokens expire after 90 days; a `401` with `error.code` `token_expired` means the user must mint a new one at the `renew_url`.
- Keep `ARTIFACT_USE_TOKEN` out of config files, source, logs, and published artifacts.
- Use `artifact_publish` for a single HTML string or small inline files (2 MiB per file). Use `artifact_upload_session` (or the stdio MCP `dir` / CLI `publish-folder`) for local folders, large files, images, PDFs, or many files.
- Use `artifact_manage` for `list`, `stats`, `set_access`, `set_preview`, `set_upstream`, `share_link`, `move`, `delete` (requires `confirm: true`), and `workspaces`. Use `artifact_comments` for the review loop: list open threads, fix, republish the same artifact, reply, resolve.
- Tool failures return `isError: true` with `structuredContent.error = {code, message, status}`; read the code before retrying.
- Titles and descriptions are public link-preview copy even when the artifact is gated. Never put secrets, recipient details, or confidential content in either. Never put credentials in HTML; use `set_upstream` when a page needs a live backend.
- Default gate is `email`; use `verified_email` when inbox control matters, `allowlist` for restricted customer material, and `public` only when intentionally low sensitivity. Upstream backends require a non-public gate.
- Keep artifact slugs lower-case hyphen-case. Public URLs are `https://artifacts.iofold.com/go/{artifact-slug}-{six-character-code}/`.

## Authoring Workflow

1. Clarify or infer the artifact mode: focused HTML tool, interactive storyboard, demo/control plane, dashboard/data explorer, narrative one-pager, report surrogate, or static file/folder.
2. For client-facing or interactive HTML, read `references/html-artifact-quality.md` before building.
3. For folders, sibling assets, split data files, images, PDFs, local libraries, or large payloads, read `references/multifile-artifacts.md`.
4. Build the working artifact first, then polish visual hierarchy, copy, responsiveness, and empty/error states.
5. Before saying it is ready or publishing it, read `references/browser-qa.md` and run the relevant checks.
6. For MCP, CLI, upload-session, workspace, or upstream details, read `references/publishing.md`.
7. When revising a published artifact, first list its open comments (`artifact_comments`), address them, republish the same artifact, then reply to and resolve each thread.

## Completion Checklist

After publishing or changing an artifact, report:

- Live URL or local path.
- Gate level.
- Artifact slug and `url_key`, and whether this was a new artifact or a republish.
- Whether a share link was created.
- Browser/interaction checks run, or why they were not run.
- Any failure reason from the JSON error body.
