import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("feedback textareas autosize and constrain long content to the drawer", async () => {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");

  assert.match(
    source,
    /function autoSizeTextarea\(/,
    "the composer needs a shared autosize behavior for comments and replies",
  );
  assert.match(
    source,
    /addEventListener\("input",\s*\(\)\s*=>\s*autoSizeTextarea\(/,
    "autosizing must run as the user types",
  );
  assert.match(
    source,
    /\.au-text\{[^}]*min-width:0[^}]*max-width:100%[^}]*overflow-x:hidden[^}]*overflow-y:hidden[^}]*resize:none/s,
    "the textarea must not create horizontal overflow or manual-resize conflicts",
  );
  assert.match(
    source,
    /\.au-composer-actions\{[^}]*flex-wrap:wrap/s,
    "composer actions must wrap inside narrow drawers",
  );
});

test("comment submission holds the draft in a disabled posting state for 300ms", async () => {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");

  assert.match(
    source,
    /function beginPostTransition\(/,
    "submission needs one shared transition instead of clearing inline",
  );
  assert.match(
    source,
    /send\.disabled = true/,
    "the first submit must synchronously guard against pointer or keyboard repeats",
  );
  assert.match(
    source,
    /if \(selecting && !reanchorFor\) endSelect\(\)/,
    "element selection must pause while the submitted target is locked",
  );
  assert.match(source, /selectButton\.disabled = true/);
  assert.match(source, /cancelButton\.disabled = true/);
  assert.match(source, /send\.textContent = "Posting…"/);
  assert.match(
    source,
    /setTimeout\(function \(\) \{[\s\S]*t\.value = "";[\s\S]*send\.disabled = false;[\s\S]*selectButton\.disabled = false;[\s\S]*cancelButton\.disabled = false;[\s\S]*\}, 300\)/,
    "the draft and guarded state must reset only after the requested 300ms",
  );
  assert.match(
    source,
    /\.au-composer\.is-posting[^}]*\.au-text\[data-body\][^}]*opacity/s,
    "the held draft needs visible posting feedback",
  );
});

test("Ctrl+Enter and Cmd+Enter invoke the guarded post button", async () => {
  const source = await readFile("apps/worker/src/widget/feedback.js", "utf8");

  assert.match(
    source,
    /bodyTextarea\.addEventListener\("keydown"/,
    "the shortcut must be scoped to the comment textarea",
  );
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /sendButton\.click\(\)/);
  assert.match(
    source,
    /aria-keyshortcuts="Control\+Enter Meta\+Enter"/,
    "assistive technology should discover both platform shortcuts",
  );
});
