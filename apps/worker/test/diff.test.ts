import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, splitLines, unifiedDiff } from "../src/diff.ts";

test("identical texts produce no diff", () => {
  assert.equal(unifiedDiff("a\nb\nc\n", "a\nb\nc\n", "a/x", "b/x"), "");
  assert.equal(unifiedDiff("", "", "a/x", "b/x"), "");
});

test("a one-line change becomes one hunk with three lines of context", () => {
  const from = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n") + "\n";
  const to = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n") + "\n";
  assert.equal(
    unifiedDiff(from, to, "a/index.html", "b/index.html"),
    [
      "--- a/index.html",
      "+++ b/index.html",
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
      "",
    ].join("\n"),
  );
});

test("hunk headers follow GNU diff for single lines and empty ranges", () => {
  // Pure insertion into an empty file: the old range is empty and anchored
  // at line 0; the new range has one line.
  assert.equal(
    unifiedDiff("", "hello\n", "a/t", "b/t"),
    "--- a/t\n+++ b/t\n@@ -0,0 +1 @@\n+hello\n",
  );
  // Pure deletion down to nothing.
  assert.equal(
    unifiedDiff("hello\n", "", "a/t", "b/t"),
    "--- a/t\n+++ b/t\n@@ -1 +0,0 @@\n-hello\n",
  );
  // Appending after the last line, with less than three lines of context.
  assert.equal(
    unifiedDiff("a\nb\n", "a\nb\nc\n", "a/t", "b/t"),
    "--- a/t\n+++ b/t\n@@ -1,2 +1,3 @@\n a\n b\n+c\n",
  );
});

test("distant changes become separate hunks; near ones merge", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const changed = [...lines];
  changed[2] = "LINE 3";
  changed[25] = "LINE 26";
  const out = unifiedDiff(
    lines.join("\n") + "\n",
    changed.join("\n") + "\n",
    "a/t",
    "b/t",
  );
  const hunks = out.split("\n").filter((l) => l.startsWith("@@"));
  assert.deepEqual(hunks, ["@@ -1,6 +1,6 @@", "@@ -23,7 +23,7 @@"]);

  const near = [...lines];
  near[10] = "LINE 11";
  near[15] = "LINE 16";
  const merged = unifiedDiff(
    lines.join("\n") + "\n",
    near.join("\n") + "\n",
    "a/t",
    "b/t",
  );
  assert.deepEqual(
    merged.split("\n").filter((l) => l.startsWith("@@")),
    ["@@ -8,12 +8,12 @@"],
  );
});

test("the edit script is minimal and always reconstructs the target", () => {
  // Deterministic PRNG so a failure is reproducible.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ["a", "b", "c", "d"];
  for (let round = 0; round < 300; round += 1) {
    const a = Array.from(
      { length: Math.floor(rand() * 12) },
      () => alphabet[Math.floor(rand() * alphabet.length)]!,
    );
    const b = Array.from(
      { length: Math.floor(rand() * 12) },
      () => alphabet[Math.floor(rand() * alphabet.length)]!,
    );
    const { lines, minimal } = diffLines(a, b);
    assert.equal(minimal, true);
    const rebuiltA = lines.filter((l) => l.op !== "+").map((l) => l.text);
    const rebuiltB = lines.filter((l) => l.op !== "-").map((l) => l.text);
    assert.deepEqual(rebuiltA, a);
    assert.deepEqual(rebuiltB, b);
    // Myers is optimal: the edit count equals (n + m - 2·LCS).
    const edits = lines.filter((l) => l.op !== " ").length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b));
  }
});

test("past the edit budget the diff degrades to a whole-file replacement", () => {
  const a = Array.from({ length: 50 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 50 }, (_, i) => `new ${i}`);
  const { lines, minimal } = diffLines(a, b, { maxEdits: 10 });
  assert.equal(minimal, false);
  assert.equal(lines.length, 100);
  assert.ok(lines.slice(0, 50).every((l) => l.op === "-"));
  assert.ok(lines.slice(50).every((l) => l.op === "+"));
  // The fallback is still a valid unified diff.
  const out = unifiedDiff(
    a.join("\n") + "\n",
    b.join("\n") + "\n",
    "a/t",
    "b/t",
    { maxEdits: 10 },
  );
  assert.match(out, /^--- a\/t\n\+\+\+ b\/t\n@@ -1,50 \+1,50 @@\n-old 0\n/);
  // A shared prefix and suffix are still recognised before the budget applies.
  const { lines: trimmed } = diffLines(
    ["same", ...a, "tail"],
    ["same", ...b, "tail"],
    { maxEdits: 10 },
  );
  assert.equal(trimmed[0]?.op, " ");
  assert.equal(trimmed[trimmed.length - 1]?.op, " ");
});

test("splitLines drops only the final newline", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
  assert.deepEqual(splitLines(""), []);
});

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}
