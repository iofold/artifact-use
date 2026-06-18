# Deployment

Artifact Use is designed to deploy to Cloudflare while creator auth is handled by WorkOS.

## Existing artifacts.iofold.com deployment

`artifacts.iofold.com` is already served by the legacy artifact host `legacy-artifacts` Worker.
Keep that Worker attached as the custom-domain origin so old direct artifact links continue to work.
Artifact Use uses an exact root route for the homepage plus more specific zone routes for `/go/*`, `/mcp*`, `/api/v1*`, `/_au*`, `/llms.txt`, `/llms-full.txt`, and publisher auth/admin/team-invite paths.
Do not add an `artifacts.iofold.com/*` catch-all route unless the legacy legacy artifact host artifact paths have been intentionally retired.
See `docs/LEGACY_ARTIFACTS.md` before changing routing.

## Existing iofold Defaults

The repo is preconfigured for the iofold Cloudflare account used by the existing artifact host:

```toml
account_id = "00000000000000000000000000000000"
MAIL_FROM = "artifacts@example.com"
```

Do not commit API tokens or WorkOS secrets.

## Required Secrets

Worker secrets:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
```

`RESEND_API_KEY` is optional for `email` gates but required for production `verified_email`.
`WORKOS_CLIENT_ID` and `WORKOS_API_KEY` are required only for the hosted publisher sign-up/sign-in web admin. The HTTP MCP resource only needs the WorkOS issuer/JWKS/audience vars.
Publisher team invitations and solo-account organization upgrades use WorkOS Organizations, Invitations, and Organization Memberships through `WORKOS_API_KEY`.

## WorkOS Vars

The local vault has existing WorkOS keys such as:

```text
WORKOS_AUTHKIT_DOMAIN
WORKOS_CLIENT_ID
WORKOS_API_KEY
```

Use those values to set Worker vars:

```toml
WORKOS_AUTHKIT_URL = "https://<WORKOS_AUTHKIT_DOMAIN>"
WORKOS_ISSUER = "https://<WORKOS_AUTHKIT_DOMAIN>"
WORKOS_JWKS_URL = "https://<WORKOS_AUTHKIT_DOMAIN>/oauth2/jwks"
WORKOS_AUDIENCE = "https://artifacts.iofold.com/mcp"
SITE_BASE_URL = "https://artifacts.iofold.com"
ARTIFACT_PUBLIC_PATH_PREFIX = "/go"
```

The hosted publisher UI uses:

```text
https://artifacts.iofold.com/login
https://artifacts.iofold.com/signup
https://artifacts.iofold.com/invite?invitation_token=<token>
https://artifacts.iofold.com/callback
https://artifacts.iofold.com/admin
```

Configure WorkOS redirects so `https://artifacts.iofold.com/callback` is allowed.
Set WorkOS invitation accept URLs to route through `/invite` with the invitation token preserved.

The Worker validates bearer tokens through JWKS for MCP requests. The publisher web admin also calls the WorkOS API at runtime for organization creation, membership checks, and team invitations.
For the existing iofold/deployment WorkOS setup, the deploy can temporarily map read/write authorization to `openid`:

```toml
ARTIFACT_USE_AUTH_SCOPES = "openid profile email offline_access"
ARTIFACT_USE_READ_SCOPES = "openid"
ARTIFACT_USE_WRITE_SCOPES = "openid"
```

For stricter production authorization, switch read/write scopes to `artifacts:*` and configure those scopes in WorkOS.
The WorkOS/AuthKit client may also need `https://artifacts.iofold.com/mcp` configured as an allowed MCP resource indicator/audience.

## Cloudflare Vars

Existing iofold project environments have Cloudflare values such as `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
Use them only in the shell/session that runs Wrangler. Do not write them into this repository.

```bash
export CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000
export CLOUDFLARE_API_TOKEN=<existing-token>
```

## Create Resources

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
```

Paste the D1 `database_id` into `apps/worker/wrangler.toml`, then:

```bash
npx wrangler d1 migrations apply artifact-use --remote
npx wrangler deploy
```

## HTTP MCP

The deployed Worker exposes:

```text
https://artifacts.iofold.com/mcp
```

Agent setup guides are available at:

```text
https://artifacts.iofold.com/llms.txt
https://artifacts.iofold.com/llms-full.txt
```

New public Artifact Use links are under:

```text
https://artifacts.iofold.com/go/{tenant}/{artifact}/
```

The remote MCP endpoint requires authentication from the first request. OAuth-capable clients should be configured with only the URL and will receive a protected-resource challenge that starts WorkOS/AuthKit login. Non-OAuth clients may still pass a WorkOS bearer token in the `Authorization` header.
