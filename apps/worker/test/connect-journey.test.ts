import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const connectPath = "apps/admin-ui/src/pages/Connect.tsx";

test("agent setup shows the canonical prompt before its copy action", async () => {
  const source = await readFile(connectPath, "utf8");
  const styles = await readFile("apps/admin-ui/src/styles.css", "utf8");

  assert.match(source, /<h2>Paste this prompt into your agent\.<\/h2>/);
  assert.match(
    source,
    /<textarea[\s\S]*aria-label="Agent setup prompt"[\s\S]*value=\{data\.quick\.prompt\}[\s\S]*readOnly/,
    "the authenticated setup prompt must be readable before it is copied",
  );
  assert.match(source, /label="Copy setup prompt"/);
  assert.doesNotMatch(
    source,
    /credential is not displayed on this page/i,
    "the page must not describe a deliberately hidden prompt",
  );
  assert.match(styles, /\.setup-prompt[\s\S]*font:[^;]*var\(--mono\)/);
  assert.match(
    styles,
    /@media \(max-width: 620px\)[\s\S]*\.setup-prompt textarea\s*\{[^}]*min-height:\s*340px;[^}]*max-height:\s*none;/,
    "the full prompt should not be trapped in a short nested scroller on mobile",
  );
});

test("device-code approval is the final fallback in the setup journey", async () => {
  const source = await readFile(connectPath, "utf8");
  const handoff = source.indexOf('className="setup-handoff"');
  const manual = source.indexOf('className="manual"');
  const device = source.indexOf('id="device-approval"');

  assert.ok(handoff >= 0, "the recommended handoff must exist");
  assert.ok(manual > handoff, "manual token controls follow the handoff");
  assert.ok(device > manual, "device approval belongs at the bottom");
  assert.match(source, /<p className="eyebrow">Fallback<\/p>/);
  assert.match(source, /<h2>Approve a device code<\/h2>/);
});

test("rotated setup prompts are visible instead of copy-only", async () => {
  const source = await readFile(connectPath, "utf8");

  assert.match(
    source,
    /<textarea[\s\S]*aria-label="New agent setup prompt"[\s\S]*value=\{minted\.prompt\}[\s\S]*readOnly/,
  );
  assert.doesNotMatch(source, /shown only as a copy action/i);
});

test("dashboard setup actions name the visible prompt as the primary path", async () => {
  const source = await readFile(
    "apps/admin-ui/src/pages/Dashboard.tsx",
    "utf8",
  );

  assert.match(source, />\s*View setup prompt\s*<\/Link>/);
  assert.match(source, /to="\/admin\/connect#device-approval"/);
  assert.match(
    source,
    /Open the visible setup prompt and\s+paste it into your agent/,
  );
});
