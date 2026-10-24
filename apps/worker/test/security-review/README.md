# Security boundary verification

These synthetic fixtures use in-memory SQLite with repository migrations,
R2 stand-ins, and test identities. They read no deployment configuration,
credentials, or production data. The browser server listens only on loopback.

Run the regression suite with `npm test`. Focused tests are
`security-regressions.test.ts`, `origin-isolation.test.ts`,
`cookie-boundaries.test.ts`, and `metadata-boundaries.test.ts`. The original
vulnerability diagnostics are retained in Git commit `cebefbe`.

Start the fixture in a separate terminal:

```bash
node --import tsx apps/worker/test/security-review/browser-server.ts
```

Then verify denied cross-artifact paths and the legitimate owner flow:

```bash
agent-browser --session au-security-review open http://localhost:18849/__audit/publisher
agent-browser --session au-security-review snapshot -i
agent-browser --session au-security-review eval --stdin < apps/worker/test/security-review/browser-probe.js
agent-browser --session au-security-review open http://localhost:18849/go/victim-abcdef/
agent-browser --session au-security-review snapshot -i
agent-browser --session au-security-review eval --stdin < apps/worker/test/security-review/browser-owner-probe.js
agent-browser --session au-security-review open http://a-attacker.localhost:18849/go/attacker-abcdef/
agent-browser --session au-security-review eval --stdin < apps/worker/test/security-review/browser-probe.js
agent-browser --session au-security-review close
```

On Linux hosts where Chromium cannot start its sandbox, the loopback fixture
can run with `--args '--no-sandbox'`. No real profile is loaded. Probe output
contains booleans and statuses and never prints bearer tokens.

`bash apps/worker/test/security-review/cookie-browser-probe.sh` verifies browser
rejection of sibling-domain cookie shadowing using intercepted synthetic HTTPS
documents. It uses a fresh browser session and closes it on exit.

For a same-site HTTPS resource-inclusion check, create an ephemeral self-signed
certificate under `.tmp/`, then start the fixture with `AUDIT_BASE_URL` set to
`https://main.audit.test:18849`, `AUDIT_HOST_SUFFIX=pages.audit.test:18849`,
and `AUDIT_TLS_KEY`/`AUDIT_TLS_CERT` pointing to those test files. Launch the
fresh test browser with
`--args '--no-sandbox,--ignore-certificate-errors,--host-resolver-rules=MAP *.audit.test 127.0.0.1,--no-proxy-server'`.
The host resolver maps every synthetic host to loopback; no production TLS or
DNS is involved. Open the publisher bootstrap and victim artifact first so
the browser has the victim's legitimate session, then open the attacker artifact
and run `browser-probe.js`. It must report `privateScriptBlocked: true` even
with that session. The owner probe also verifies its private script loads and
the public script remains reusable across origins.

The fixture exercises actual routing, authorization and handoffs, with a
synthetic admin shell. It does not emulate edge caching, WAF rules, production
TLS, or the remote membership directory. Upstream tests use no network calls.
The deploy checklist in `docs/DEPLOY.md` covers wildcard DNS/TLS and migrations.
Existing browsers must sign in or pass their gate again after the cookie
migration. Old shared-origin browser storage is not copied to artifact pages.

Detailed findings and receipts are saved privately in
`docs/internal/SECURITY_REVIEW_2026-10-24.md`.
