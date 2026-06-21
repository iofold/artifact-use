---
name: artifact-use
description: Use when creating, polishing, publishing, sharing, gating, or checking stats for Artifact Use artifacts through the hosted API, CLI, or MCP server. Applies to self-contained interactive HTML artifacts, single-file HTML tools, multi-file static artifacts, folders, images/PDFs, and Artifact Use admin/share workflows. Use this instead of Wrangler, Cloudflare tokens, R2, or direct D1 access.
---

# Artifact Use

Artifact Use publishes static artifacts to `https://artifacts.iofold.com` without exposing Cloudflare credentials to agents.

## Core Rules

- Never use Wrangler, Cloudflare API tokens, direct R2 credentials, or direct D1 access for publishing artifacts.
- Prefer hosted HTTP MCP at `https://artifacts.iofold.com/mcp`; OAuth-capable clients should authenticate through the MCP prompt.
- For OAuth-capable clients, configure only the MCP URL. Do not add an `Authorization` header unless you are intentionally passing a fresh bearer token.
- After `codex mcp login artifact-use`, restart the active Codex session before using `mcp__artifact_use`; Codex may keep the old HTTP MCP auth state in memory.
- Use `ARTIFACT_USE_TOKEN` only for CLI, local stdio MCP, or non-OAuth clients.
- Use `artifact_publish` for a single HTML string or small inline multi-file payloads.
- Use `artifact_upload_session`, local stdio MCP with `dir`, or the CLI for local folders, large files, images, PDFs, or multi-file artifacts.
- Use `artifact_manage` for list, stats, access changes, and share links. `action: "list"` returns `url_key`; use it for exact management calls.
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

## Completion Checklist

After publishing or changing an artifact, report:

- Live URL or local path.
- Gate level.
- Artifact slug and `url_key`.
- Whether a share link was created.
- Browser/interaction checks run, or why they were not run.
- Any failure reason from the JSON error body.
