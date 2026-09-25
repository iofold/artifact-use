# @artifact-use/mcp-server

Local stdio MCP server for [Artifact Use](https://artifacts.iofold.com). It
exposes the same four tools as the hosted endpoint (`artifact_publish`,
`artifact_upload_session`, `artifact_manage`, `artifact_comments`) and adds
`dir` and `dry_run` to `artifact_publish`, so an agent can publish a local
folder without streaming file bytes through model context. Use it when the
harness cannot speak hosted MCP with OAuth; otherwise prefer
`https://artifacts.iofold.com/mcp`.

```json
{
  "mcpServers": {
    "artifact-use": {
      "command": "npx",
      "args": ["-y", "@artifact-use/mcp-server"],
      "env": {
        "ARTIFACT_USE_API_BASE": "https://artifacts.iofold.com",
        "ARTIFACT_USE_TOKEN": "au_creator_..."
      }
    }
  }
}
```

Mint the creator token at `/admin/connect`; tokens expire after 90 days and a
`401` with `error.code` `token_expired` means a new one is needed. User-scoped
tokens name their workspace with the `workspace` tool argument,
`ARTIFACT_USE_WORKSPACE`, or a project `.artifact-use.json`. Pass an existing
artifact's `url_key` as `artifact` to republish it in place.

Full agent guide: https://artifacts.iofold.com/llms-full.txt. Source and
issues: https://github.com/iofold/artifact-use. MIT licensed.
