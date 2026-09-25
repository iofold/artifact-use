# @artifact-use/cli

JSON-first command line for [Artifact Use](https://artifacts.iofold.com):
publish HTML tools, dashboards, and whole static folders as stable, gated,
reviewable links, then manage access, share links, stats, and reviewer
comments. Built for coding agents and shell workflows; every command takes
`--json` input and prints JSON.

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'   # mint at /admin/connect

npx -y @artifact-use/cli publish-folder --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'
```

Commands: `publish-html`, `publish-folder` (`--dry-run` previews the
manifest), `list`, `stats`, `gate`, `preview`, `share`, `comments`,
`workspaces`, and `schema --all` for every command's JSON schema. Pass an
existing artifact's `url_key` as `artifact` to republish it in place.
`--workspace <org id or slug>`, `ARTIFACT_USE_WORKSPACE`, or a project
`.artifact-use.json` selects the workspace for user-scoped tokens.

Creator tokens expire after 90 days; a `401` with `error.code`
`token_expired` means a new one is needed from `/admin/connect`.

Full agent guide: https://artifacts.iofold.com/llms-full.txt. Source and
issues: https://github.com/iofold/artifact-use. MIT licensed.
