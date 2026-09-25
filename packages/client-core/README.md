# @iofold/artifact-use-core

Shared internals for the [Artifact Use](https://artifacts.iofold.com) CLI
(`@iofold/artifact-use`) and stdio MCP server (`@iofold/artifact-use-mcp`):
configuration resolution (`ARTIFACT_USE_API_BASE`, `ARTIFACT_USE_TOKEN`,
workspace pins), the authenticated `api()` helper, the folder walker and
manifest builder, direct file upload, `publishFolder`, and the MCP tool
schemas (`@iofold/artifact-use-core/schemas`).

Install one of those packages instead unless you are building your own client.
The API is small and may change between minor versions.

Source and issues: https://github.com/iofold/artifact-use. MIT licensed.
