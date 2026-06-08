# MCP Installation

Artifact Use exposes HTTP MCP at:

```text
https://art-use.iofold.com/mcp
```

The repository also ships a local stdio MCP server for environments that need the tool itself to walk a folder on disk.

## Environment

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

- `artifact_use_publish_folder`
- `artifact_use_publish_html`
- `artifact_use_publish_files`
- `artifact_use_list_artifacts`
- `artifact_use_get_stats`
- `artifact_use_create_share_link`

## Folder Publishing Over MCP

HTTP MCP cannot read local files by itself. Use one of these paths:

- `artifact_use_publish_html` for one HTML string.
- `artifact_use_publish_files` for small multi-file artifacts where the agent passes inline text or base64 file content.
- Local CLI or local stdio MCP for large folders that must be walked from disk.
