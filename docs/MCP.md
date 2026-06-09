# MCP Installation

Artifact Use exposes HTTP MCP at:

```text
https://art-use.iofold.com/mcp
```

The repository also ships a local stdio MCP server for environments that need the tool itself to walk a folder on disk.

## Auth

Remote HTTP MCP requires auth from the first request. OAuth-capable clients receive a `401` with MCP protected-resource metadata and should prompt for WorkOS/AuthKit sign-in automatically.

For CLI usage, local stdio MCP, or non-OAuth clients, pass a WorkOS bearer token explicitly:

```bash
export ARTIFACT_USE_API_BASE=https://art-use.iofold.com
export ARTIFACT_USE_TOKEN=<workos-oauth-token>
```

## Codex

Use the bundled Codex plugin under:

```text
plugins/codex/artifact-use
```

Or copy `integrations/codex.mcp.json` into a project `.mcp.json`. The default config uses HTTP MCP.

## Claude Code

Merge `integrations/claude-code/settings.example.json` into your Claude Code settings. The default config uses HTTP MCP.

## Tools

- `artifact_publish`: publish single HTML, small inline multi-file payloads, or a local `dir` when using the bundled stdio MCP. `tenant` is optional; omit it to use the authenticated account's default tenant.
- `artifact_manage`: list artifacts, fetch stats, update access, or create share links. `artifact_manage` with `action: "list"` returns `default_tenant`.

## File Publishing Over MCP

HTTP MCP cannot read local files by itself. Use one of these paths:

- Remote `artifact_publish` with `html` for one HTML string.
- Remote `artifact_publish` with `files` for small multi-file artifacts where the agent passes inline text or base64 file content. This is convenient but consumes MCP request size and may consume model context in some clients.
- Local stdio MCP `artifact_publish` with `dir`, or the CLI `publish-folder`, for large folders. In this mode the tool reads files from disk and streams bytes to the hosted API; the model only sees the path, manifest, and final URL.

Do not guess tenant slugs. Omit `tenant` unless the user explicitly asks for a tenant path. The server resolves an existing tenant for the authenticated account or creates a safe default.

Future remote-only large upload support should use an upload-session pattern: MCP creates a draft artifact and returns short-lived upload URLs; the client or companion CLI uploads bytes directly; MCP then completes the manifest. That keeps large images, PDFs, videos, and folders out of the LLM context.
