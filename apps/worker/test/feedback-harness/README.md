# Feedback widget test harness

Visual/behavioural fixtures for the injected feedback widget
(`apps/worker/src/widget/feedback.js`). Used to verify the widget across states,
viewports, and edge cases with `agent-browser` without standing up the full
worker. See `docs/FEEDBACK_UX_PLAN.md` for the behaviours under test.

## Static harness (no backend)

Serves the real widget source against several sample pages with a stubbed
`/_au/comments` API seeded to exercise the tricky cases (cross-page comments,
resolved threads, replies, the resolution ladder, a z-index/dialog/fullscreen
stress page).

```bash
node apps/worker/test/feedback-harness/server.mjs        # http://127.0.0.1:8799
AU_DELAY=2000 node apps/worker/test/feedback-harness/server.mjs   # slow API to see the loading state
```

Pages (all under `/go/claims-demo-a1b2c3/`):

- `/` — single-page tool (buttons, table)
- `/findings.html`, `/evidence.html` — other pages of the same artifact
- `/resolve.html` — resolution-ladder fixtures (hidden / display:none / missing /
  off-screen / multi-anchor targets)
- `/stress.html` — z-index overlay, modal `<dialog>`, fullscreen

The widget UI lives in an open Shadow DOM host, so reach it from the page with:

```js
const R = document.getElementById("au-host").shadowRoot;
R.querySelector(".au-launch").click();
```

## End-to-end against the real worker (staging)

Runs the actual worker (real `serve.ts`, gate, D1, R2, migration `0002`).

```bash
# 1. local D1 with migrations
cd apps/worker && npx wrangler d1 migrations apply artifact-use --local

# 2. start the worker as a local staging target
npx wrangler dev --ip 127.0.0.1 --port 8788 \
  --var SITE_BASE_URL:http://localhost:8788 \
  --var DEV_AUTH_USER_ID:user_staging0001 \
  --var DEV_AUTH_ORG_ID:org_staging \
  --var DEV_AUTH_EMAIL:staging@example.com
# (.dev.vars must provide DEV_AUTH_TOKEN and SESSION_SECRET)

# 3. publish a 2-page email-gated artifact via the real publish API
node apps/worker/test/feedback-harness/seed-staging.mjs

# 4. open the printed /go/<url_key>/ in a browser, enter any email at the gate,
#    and exercise the widget against the real backend.
```

## Remote Cloudflare deploy

A real remote staging deploy additionally needs **R2 write** on the Cloudflare
token (to create/bind the `BUCKET` bucket) plus a real `account_id` and route in
`wrangler.toml`. With those: `npm --workspace apps/worker run deploy`.
