# Contributing to Artifact Use

Thanks for helping improve Artifact Use.

## Before you start

- Search existing issues before opening a new one.
- Use a private email to `opensource@iofold.com` for security reports.
- Keep pull requests focused on one coherent outcome.
- Never commit credentials, customer data, private artifacts, deployment IDs,
  internal operations notes, or generated local configuration.

## Development

Artifact Use requires Node.js 20.11 or newer.

```bash
npm ci
npm run check
npm test
npm run build
```

The Worker, admin UI, CLI, client core, and MCP server are npm workspaces.
Deployment-specific files such as `.dev.vars`, `wrangler.prod.toml`, and
`wrangler.staging.toml` are intentionally ignored.

## Pull requests

All changes, including maintainer changes, go through pull requests. Pull
requests must keep linear history and pass CI before merge.

Explain the user-visible outcome, add or update tests for behavior changes, and
include screenshots for visible UI changes. Update documentation and examples
when a change affects setup, deployment, APIs, or agent workflows.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
