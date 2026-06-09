# Deployment

Artifact Use is designed to deploy to Cloudflare while creator auth is handled by WorkOS.

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
```

`RESEND_API_KEY` is optional for `email` gates but required for production `verified_email`.

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
WORKOS_AUDIENCE = "https://art-use.iofold.com/mcp"
```

The Worker validates bearer tokens through JWKS; it does not need `WORKOS_API_KEY` at runtime for the current v1.
For the existing iofold/deployment WorkOS setup, the deploy can temporarily map read/write authorization to `openid`:

```toml
ARTIFACT_USE_AUTH_SCOPES = "openid profile email offline_access"
ARTIFACT_USE_READ_SCOPES = "openid"
ARTIFACT_USE_WRITE_SCOPES = "openid"
```

For stricter production authorization, switch read/write scopes to `artifacts:*` and configure those scopes in WorkOS.
The WorkOS/AuthKit client may also need `https://art-use.iofold.com/mcp` configured as an allowed MCP resource indicator/audience.

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
https://art-use.iofold.com/mcp
```

Use a WorkOS bearer token in the `Authorization` header. The plugin and integration examples default to this HTTP MCP endpoint.
