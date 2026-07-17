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
