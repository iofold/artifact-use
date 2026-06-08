# MCP Installation

Artifact Use ships a local stdio MCP server because local agents often need to publish folders from the filesystem.
The server calls the hosted API at `https://art-use.iofold.com` by default.

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

Or copy `integrations/codex.mcp.json` into a project `.mcp.json`.

## Claude Code

Merge `integrations/claude-code/settings.example.json` into your Claude Code settings.

## Tools

- `artifact_use_publish_folder`
- `artifact_use_publish_html`
- `artifact_use_list_artifacts`
- `artifact_use_get_stats`
- `artifact_use_create_share_link`

The hosted Worker also exposes a minimal `/mcp` HTTP endpoint for clients that support remote OAuth MCP, but folder publishing should use the local stdio server so the tool can read local files.
