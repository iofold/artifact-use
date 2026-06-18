# Browser QA

Use this before saying an HTML artifact is ready, especially before sharing or publishing client-facing work.

## Local Preview

For a fully self-contained file:

```bash
agent-browser open "file:///ABSOLUTE/PATH/index.html"
```

For a multi-file artifact:

```bash
python3 -m http.server 8765 -d artifact-dir
agent-browser open "http://127.0.0.1:8765/"
```

If the browser command shape is unclear, run:

```bash
agent-browser --help
agent-browser skills get core
```

## Required Checks

- Desktop first viewport: the primary purpose is obvious and important controls are not hidden behind the feedback widget area.
- Mobile viewport: no horizontal scroll, no overlapping text, controls are usable, and the main workflow is reachable.
- Main interaction path: click through the intended story/tool flow, not just page load.
- Error/empty path: trigger at least one invalid input, empty result, missing data, or failed fetch path for tools.
- Keyboard basics: Tab reaches controls in a sensible order; Escape closes modals/panels where relevant.
- External dependencies: CDN/API failures show an understandable message instead of a blank screen.
- Copy/download features: verify the action or verify a visible fallback/status message when browser permissions block automation.

## Screenshot Evidence

Save screenshots under `.tmp/html-artifact-qa/<slug>/`.

Suggested coverage:

- `desktop.png` around 1280-1440px wide.
- `mobile.png` around 390px wide.
- `interaction.png` after the main click path opens a drilldown, modal, generated output, transformed result, or selected state.

When testing UI/UX quality or bugs, use screenshots and have them reviewed by Gemini CLI in batch when available. Keep the prompt focused on concrete defects: overlap, unreadable text, broken hierarchy, generic visual defaults, missing affordances, and mobile usability. Do not claim Gemini reviewed screenshots unless that command actually ran.

## Common Defects To Fix

- Horizontal scroll on mobile.
- Text overflowing buttons, chips, cards, table cells, or sidebars.
- Dense dashboards stacking into unreadable mobile sections.
- Lower-right floating controls covering primary artifact controls.
- First viewport reads like a marketing page instead of the actual artifact.
- Buttons describe implementation rather than user actions.
- Clickable cards lack keyboard access or visible focus.
- Synthetic data looks like placeholder filler rather than a plausible scenario.
- Console errors occur on initial load or first interaction.

## Done Statement

Report:

- Local path and, if deployed, URL.
- Viewports and interactions checked.
- Any verification not run and why.
- Any content assumptions needing human validation.
