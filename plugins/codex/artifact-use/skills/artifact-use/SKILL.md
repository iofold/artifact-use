---
name: artifact-use
description: Use when creating, polishing, publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to self-contained interactive HTML artifacts, single-file HTML tools, multi-file static artifacts, folders, images/PDFs, and Artifact Use admin/share workflows. Use this instead of Wrangler, Cloudflare tokens, R2, or direct D1 access.
---

# Artifact Use

Artifact Use publishes static artifacts to `https://artifacts.iofold.com` without exposing Cloudflare credentials to agents.

## Core Rules

- Never use Wrangler, Cloudflare API tokens, direct R2 credentials, or direct D1 access for publishing artifacts.
- Prefer hosted HTTP MCP at `https://artifacts.iofold.com/mcp`; use CLI, direct HTTP, or local stdio MCP only as advanced fallbacks. The current harness guide is at `https://artifacts.iofold.com/llms.txt`.
- Codex desktop, CLI, and IDE share MCP config and credentials on a host; use URL-only OAuth by default. Desktop: **Settings → MCP servers → Add server → Streamable HTTP**, enter the hosted URL, then **Save → Restart → Authenticate**. CLI equivalent: `codex mcp add artifact-use --url https://artifacts.iofold.com/mcp`, then `codex mcp login artifact-use`. Do not use the creator token on this path.
- Before Codex OAuth, remove any existing `bearer_token_env_var` from the `artifact-use` config (or remove and re-add the server URL-only). Codex tries a configured bearer token before stored OAuth credentials.
- Codex CLI bearer is a fallback only when OAuth is unavailable or unreliable. `ARTIFACT_USE_TOKEN` must exist in the launcher terminal before Codex starts; run `codex mcp remove artifact-use`, re-add it with `codex mcp add artifact-use --url https://artifacts.iofold.com/mcp --bearer-token-env-var ARTIFACT_USE_TOKEN`, then restart Codex from that terminal. An export inside the running session cannot update its parent process.
- Claude Code: use hosted MCP OAuth. Run `claude mcp add --transport http artifact-use https://artifacts.iofold.com/mcp`, then open `/mcp`, select `artifact-use`, and authenticate. Do not use the creator token on this path.
- Other clients: prefer hosted MCP OAuth. Use the supplied creator token as a hosted MCP bearer credential only when OAuth is unavailable. Never configure bearer auth and OAuth simultaneously.
- No token and no browser? Use the connect flow: `POST /api/v1/connect/start`, have the human approve the code at `/connect`, then `POST /api/v1/connect/poll` for a bearer token; verify with `GET /api/v1/me`. Details in `references/publishing.md`.
- Use `ARTIFACT_USE_TOKEN` only for the Codex CLI bearer fallback and advanced CLI, local stdio MCP, direct HTTP, or non-OAuth paths. Keep it out of config files, source, logs, and published artifacts.
- Use `artifact_publish` for a single HTML string or small inline multi-file payloads.
- Prefer hosted `artifact_upload_session` for local folders, large files, images, PDFs, or multi-file artifacts; use local stdio MCP with `dir` or the CLI only as an advanced fallback.
- Use `artifact_manage` for list, stats, access changes, and share links. `action: "list"` returns `url_key` (use it for exact management calls) and per-artifact `open_comments` counts.
- Use `artifact_comments` for the feedback loop: list open feedback (`status: "open"`), apply the fixes, republish the same artifact slug, then reply to each thread (`parent_id`) and resolve it (`comment_id`). Details in `references/publishing.md`.
- Publish with a lower-case artifact slug; use the returned `url_key` when managing an existing artifact.
- Keep artifact slugs lower-case hyphen-case.
- Default gate is `email`; use `verified_email` when inbox control matters, `allowlist` for restricted customer material, and `public` only when intentionally low sensitivity.
- New public Artifact Use URLs are under `/go/{artifact-slug}-{six-character-code}/`.

## Authoring Workflow

1. Clarify or infer the artifact mode: focused HTML tool, interactive storyboard, demo/control plane, dashboard/data explorer, narrative one-pager, report surrogate, or static file/folder.
2. For client-facing or interactive HTML, read `references/html-artifact-quality.md` before building.
3. For folders, sibling assets, split data files, images, PDFs, local libraries, or large payloads, read `references/multifile-artifacts.md`.
4. Build the working artifact first, then polish visual hierarchy, copy, responsiveness, and empty/error states.
5. Before saying it is ready or publishing it, read `references/browser-qa.md` and run the relevant checks.
6. For MCP, CLI, or upload-session details, read `references/publishing.md`.
7. When revising a published artifact, first list its open comments (`artifact_comments`), address them, republish the same slug, then reply to and resolve each thread.

## Completion Checklist

After publishing or changing an artifact, report:

- Live URL or local path.
- Gate level.
- Artifact slug and `url_key`.
- Whether a share link was created.
- Browser/interaction checks run, or why they were not run.
- Any failure reason from the JSON error body.
