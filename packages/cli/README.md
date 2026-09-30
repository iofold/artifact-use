# artifact-use-cli

JSON-first command line for [Artifact Use](https://artifacts.iofold.com),
installed as the `artifact-use` binary: publish HTML tools, dashboards, and
whole static folders as stable, gated, reviewable links, then manage access, share links, stats, and reviewer
comments. Built for coding agents and shell workflows; every command takes
`--json` input and prints JSON.

```bash
export ARTIFACT_USE_API_BASE=https://artifacts.iofold.com
export ARTIFACT_USE_TOKEN='au_creator_...'   # mint at /admin/connect

npx -y artifact-use-cli publish-folder --json '{
  "artifact": "claims-demo",
  "title": "Claims Demo",
  "dir": "dist",
  "gate_level": "email"
}'
```

Commands: `publish-html`, `publish-folder` (`--dry-run` previews the
manifest), `list`, `stats`, `gate`, `preview`, `share`, `comments`,
`workspaces`, and `schema --all` for every command's JSON schema. Pass an
existing artifact's `url_key` as `artifact` to republish it in place, with
your last `version_id` as `base_version_id` and a one-line `change_note`
(at most 280 characters) saying what changed. `share` takes `kind`
(`recipient` by default, `password`, or `open`), `label`, `passcode`,
`expires_days` and `max_opens`; `comments` lists with `status`, `since` and
`wait` (up to 25 s long-poll; pass the returned `next_since` back as `since`),
and posts, resolves or reopens with `action`.
`artifact-use --help` prints the usage with each command's fields and the
environment variables; `artifact-use help <command>` prints that command's
input schema; `--version` prints the CLI version.
`--workspace <org id or slug>`, `ARTIFACT_USE_WORKSPACE`, or a project
`.artifact-use.json` selects the workspace for user-scoped tokens.

Creator tokens expire after 90 days; a `401` with `error.code`
`token_expired` means a new one is needed from `/admin/connect`.

Full agent guide: https://artifacts.iofold.com/llms-full.txt. Source and
issues: https://github.com/iofold/artifact-use. MIT licensed.
