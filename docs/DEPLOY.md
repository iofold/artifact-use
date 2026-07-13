# Deployment

Artifact Use is designed to deploy to Cloudflare while creator auth is handled
by WorkOS/AuthKit.

## Required Services

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- Cloudflare Email Sending if you enable `verified_email` gates
- WorkOS/AuthKit for creator and publisher auth
- A monitored abuse mailbox with a primary and backup owner

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
- the `EMAIL` binding and an allowed `MAIL_FROM` address
- your public `SITE_BASE_URL`
- your public `ABUSE_EMAIL` mailbox
- your WorkOS/AuthKit issuer, audience, and JWKS URL

Keep these environment-specific values out of the public repo: copy
`apps/worker/.env.deploy.example` to `apps/worker/.env.deploy` (gitignored) as a
single reference, and keep the real, operative `wrangler.prod.toml` /
`wrangler.staging.toml` gitignored alongside it.

Then apply the baseline schema:

```bash
npx wrangler d1 migrations apply artifact-use --remote
```

## Worker Secrets

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WORKOS_CLIENT_ID
npx wrangler secret put WORKOS_API_KEY
```

## Email Sending

`verified_email` gates send codes through Cloudflare's native Worker binding;
there is no separate mail API key. Enable a dedicated sending domain or
subdomain, verify its DNS status, and allow the exact sender in the binding:

```bash
npx wrangler email sending enable updates.example.com
npx wrangler email sending settings updates.example.com
npx wrangler email sending dns get updates.example.com
```

```toml
[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["artifacts@updates.example.com"]

[vars]
MAIL_FROM = "artifacts@updates.example.com"
MAIL_FROM_NAME = "Artifact Use"
```

Cloudflare permits arbitrary recipients on Workers Paid. New sending accounts
start with conservative daily quotas, so check the Email Sending dashboard and
request a quota increase before opening a high-volume gate. The application's
OTP rate limits still apply when delivery fails.

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

For MCP clients to authenticate with OAuth, enable both of these in the
AuthKit environment (Dashboard → Applications → Configuration; both are off
by default in new environments):

- **Dynamic Client Registration** — MCP clients that register themselves
  (RFC 7591). Without it, clients fail with "does not support dynamic client
  registration".
- **Client ID Metadata Documents** — clients that identify with a URL-based
  client ID, e.g. Claude Code (`https://claude.ai/oauth/claude-code-client-metadata`).
  Without it, the authorize request dies on the AuthKit error page.

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

## Abuse operations

Set a non-secret Worker variable for the mailbox shown on the homepage, legal
pages, and injected artifact widget:

```toml
ABUSE_EMAIL = "abuse@example.com"
```

Before deploying those links, send an external test message and confirm the
operational handoff. A configured address is not enough by itself: the mailbox
needs named primary and backup owners plus a documented intake, evidence
preservation, suspension, and restore procedure, and the public legal text and
formal-notice procedure need human legal review.

## Selective Browser Integrity Check bypass

Browser Integrity Check can reject legitimate command-line and agent clients with
non-browser user agents. Keep it enabled for the rest of the zone and add one
**zone-level custom skip rule** for only the product paths that must be
machine-readable:

```text
(http.request.uri.path wildcard "/api/v1/*") or
(http.request.uri.path eq "/mcp") or
(http.request.uri.path wildcard "/.well-known/oauth-*") or
(http.request.uri.path eq "/llms.txt") or
(http.request.uri.path eq "/llms-full.txt") or
(http.request.uri.path wildcard "/go/*") or
(http.request.uri.path wildcard "/_au/*") or
(http.request.uri.path eq "/health")
```

Choose the **Skip** action and select only **Browser Integrity Check** (API product
value `bic`). Leave rule logging enabled. Do not skip managed WAF rules, rate-limit
phases, security level, user-agent blocking, or all remaining custom rules. Do not
include `/admin`, `/login`, `/callback`, or other publisher/auth paths.

Cloudflare documents BIC as a product that can be selectively disabled by a custom
skip rule; `bic` is the product identifier in the Ruleset Engine. See
[Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)
and [skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/).

After the rule is applied, verify from a network outside the Cloudflare dashboard
session:

```bash
curl -fsS https://artifacts.example.com/health
curl -fsS https://artifacts.example.com/llms.txt >/dev/null
python3 -c 'import urllib.request; print(urllib.request.urlopen("https://artifacts.example.com/health").status)'
```

Also read one public artifact with curl, Codex, and Claude. Admin/auth pages should
retain their normal Cloudflare protections, and application auth, gates, CSRF,
moderation, and D1 limits remain in force on skipped product paths.

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
