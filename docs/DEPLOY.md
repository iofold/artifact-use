# Deployment

Artifact Use is designed to deploy to Cloudflare while creator auth is handled
by WorkOS/AuthKit.

## Required Services

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- WorkOS/AuthKit for creator and publisher auth
- Resend or another email provider if you enable `verified_email` gates

## Create Cloudflare Resources

```bash
cd apps/worker
npx wrangler d1 create artifact-use
npx wrangler r2 bucket create artifact-use
```

Update `apps/worker/wrangler.toml` with:

- your Cloudflare `account_id`
- your route patterns and zone name
- the D1 `database_id`
- the R2 bucket name
- your public `SITE_BASE_URL`
- your WorkOS/AuthKit issuer, audience, and JWKS URL

Then apply the baseline schema:

```bash
npx wrangler d1 migrations apply artifact-use --remote
```

## Worker Secrets

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put RESEND_API_KEY
```

`RESEND_API_KEY` is optional for `email` gates but required for production
`verified_email` gates.

## WorkOS/AuthKit

Configure redirect URLs for your deployment:

```text
https://artifacts.example.com/login
https://artifacts.example.com/signup
https://artifacts.example.com/invite?invitation_token=<token>
https://artifacts.example.com/callback
https://artifacts.example.com/admin
```

Configure the OAuth/MCP audience to match your Worker route:

```text
https://artifacts.example.com/mcp
```

The Worker validates bearer tokens through JWKS for MCP requests. The publisher
web admin also calls the WorkOS API at runtime for organization creation,
membership checks, and team invitations.

For a simple initial deployment, these scopes are enough:

```toml
ARTIFACT_USE_AUTH_SCOPES = "openid profile email offline_access"
ARTIFACT_USE_READ_SCOPES = "openid"
ARTIFACT_USE_WRITE_SCOPES = "openid"
```

For stricter production authorization, switch read/write scopes to dedicated
`artifacts:*` scopes and configure them in WorkOS.

Set `ARTIFACT_USE_SUPER_ADMIN_USER_IDS` to a comma-separated list of WorkOS
`user_...` IDs that may access `/admin/super` and move artifacts between WorkOS
organizations. Ownership moves always set `created_by` to the target WorkOS
user.

## Deploy

```bash
npx wrangler deploy
```

The deployed Worker exposes:

```text
https://artifacts.example.com/mcp
https://artifacts.example.com/llms.txt
https://artifacts.example.com/llms-full.txt
https://artifacts.example.com/go/{artifact-slug}-{six-character-code}/
```

OAuth-capable MCP clients should be configured with the MCP URL and will receive
a protected-resource challenge that starts WorkOS/AuthKit login. Non-OAuth
clients can pass a WorkOS bearer token in the `Authorization` header.
