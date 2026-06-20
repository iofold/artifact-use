# HTML Artifact Quality

Use this when creating or improving self-contained HTML artifacts, browser-native tools, client demos, dashboards, or interactive explainers. The default is a durable, no-build `index.html` that can be opened, reviewed, and revised by a future agent.

This guidance is informed by durable HTML tool and artifact writing practices:
prefer small vanilla HTML/CSS/JS, no React or build step by default, and publish
somewhere stable instead of leaving work inside an LLM sandbox.

## Default Shape

- Prefer one self-contained `index.html` with inline CSS and JavaScript.
- Avoid React, JSX, bundlers, package installs, and build steps unless the existing artifact already uses them or the user explicitly asks.
- Keep source readable. A future agent should be able to inspect or rewrite it quickly.
- Use pinned CDN dependencies only when a well-known browser library materially reduces risk or complexity. Prefer local vendored files for client-critical or CDN-fragile dependencies.
- Keep the first viewport useful. Build the artifact itself, not a landing page that explains a future artifact.
- Include `<meta name="viewport" content="width=device-width, initial-scale=1">` and usually `<meta name="robots" content="noindex,nofollow">` for unlisted/client material.

## UX Standards

- Match the domain: operational SaaS and data artifacts should be dense, quiet, and scannable; storyboards should make the buyer situation and action path concrete.
- Use semantic HTML where practical: real buttons, labels, ordered headings, alt text, and native form controls before custom ARIA.
- Make the main interaction obvious without instructions text. Add visible help only for domain concepts or unavoidable workflow details.
- Use stable responsive constraints: grid tracks, `minmax()`, `aspect-ratio`, `min-height`, `max-width`, and explicit overflow behavior.
- Make mobile deliberate. Do not collapse a dense desktop dashboard into unreadable stacked blocks.
- Avoid generic AI defaults: purple/blue gradient wash, decorative card grids, oversized empty heroes, arbitrary glowing accents, and placeholder filler.
- Avoid placing primary controls in the lower-right corner because hosted artifacts may include a floating feedback/comment control.
- Do not put secrets, private API keys, or private customer data into HTML. User-supplied keys may stay in `localStorage` only when the user understands the tradeoff.

## Interaction Patterns

- Support paste, file-open, drag/drop, copy buttons, and downloads when they reduce user effort.
- Use URL state for small bookmarkable/shareable state such as current tab, selected item, or filter.
- Use `localStorage` for drafts, user preferences, and larger private state. Version storage keys.
- Generate downloads with `Blob` and `URL.createObjectURL()` instead of requiring a server.
- Browser-only artifacts may call CORS-enabled APIs. Show API failures clearly and never silently fake data.
- For LLM/API demos, keep keys user-supplied and local. Never hardcode an Artifact Use, WorkOS, OpenAI, Anthropic, Gemini, Cloudflare, or customer key.

## Data And Rendering

- Put demo data in named constants or clearly named data modules: `const CLAIMS = [...]`, `const VENDORS = [...]`.
- Prefer small pure render functions and event delegation with `data-*` attributes for repeated controls.
- Use `textContent` for untrusted text. Use `innerHTML` only for controlled templates you own.
- Include loading, empty, invalid-input, and error states. Client-facing artifacts should not fail into a blank page.
- Do not invent customer facts, metrics, logos, screenshots, or compliance claims. Label assumptions unless sourced.
- If useful examples exist in the current repo or artifact library, inspect one
  or two nearby artifacts before designing from scratch.

## Base Skeleton

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Artifact title</title>
    <style>
      :root {
        color-scheme: light;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
      }
      button,
      input,
      textarea,
      select {
        font: inherit;
      }
    </style>
  </head>
  <body>
    <main id="app"></main>
    <script type="module">
      const $ = (id) => document.getElementById(id);
    </script>
  </body>
</html>
```

## Ready Checklist

- The artifact works without a build step.
- The primary workflow is usable in the first viewport.
- Desktop and mobile layouts have no overlapping text or horizontal overflow.
- Main controls have visible focus and usable labels.
- Copy/download/paste/file paths were exercised when present.
- External dependencies and API failures have readable error states.
