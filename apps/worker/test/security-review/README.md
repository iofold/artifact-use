# Security review diagnostics, 2026-10-24

These fixtures reproduce security findings in revision `b1881a3`. They use
in-memory SQLite with all repository migrations, synthetic R2 objects and
synthetic identities. They do not read deployed configuration or credentials.
The browser server listens only on loopback.

**A passing `FINDING` probe demonstrates the vulnerable behavior.** These are
diagnostics, deliberately excluded from the normal `*.test.ts` suite. During
remediation, replace each diagnostic with a regression test asserting denial
in the normal suite. `CONTROL` probes assert existing security boundaries.

```bash
npm run widget:build -w apps/worker
npm run llms:build -w apps/worker
node --import tsx --test apps/worker/test/security-review/probes.ts
```

For the browser reproduction, start the fixture in a separate terminal:

```bash
node --import tsx apps/worker/test/security-review/browser-server.ts
```

Then use a fresh browser session (the bootstrap represents a victim already
signed into their own workspace, visiting another tenant's artifact):

```bash
agent-browser --session au-security-review open http://localhost:18849/__audit/publisher
agent-browser --session au-security-review snapshot -i
agent-browser --session au-security-review eval --stdin < apps/worker/test/security-review/browser-probe.js
agent-browser --session au-security-review close
```

On Linux hosts where Chromium cannot start its sandbox, this loopback-only
fixture was run with `--args '--no-sandbox'`. No real account state is loaded.
The output reports booleans and HTTP statuses and never prints bearer tokens.

The fixture uses actual worker routing and authorization code, a synthetic
admin shell and an R2 stand-in. It does not emulate Cloudflare edge caching,
WAF rules, WorkOS membership deletion, or production network behavior. The
upstream probe checks request options; redirect leakage is additionally based
on Cloudflare's documented Workers behavior, not a live redirect exploit.

The detailed findings and evidence are saved locally in
`docs/internal/SECURITY_REVIEW_2026-10-24.md`, following the repository's
existing convention for private operational documents.
