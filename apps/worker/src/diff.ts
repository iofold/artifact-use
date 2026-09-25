// Line-based text diff with unified output, dependency-free.
//
// Myers' O((N+M)D) shortest-edit-script algorithm on lines, after trimming
// the common prefix and suffix. Two guards keep it inside a Worker's CPU and
// memory budget for the 200 KB files the version diff feeds it: a line cap
// per side and an edit-distance cap. Past either, the result degrades to a
// whole-file replacement (every old line removed, every new line added),
// which is still a valid unified diff — just not a minimal one.

export type DiffOp = " " | "-" | "+";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface UnifiedDiffOptions {
  // Lines of unchanged context around each change (default 3).
  context?: number;
  // Edit-distance budget before falling back to a whole-file replacement.
  maxEdits?: number;
  // Per-side line budget before the same fallback.
  maxLines?: number;
}

export const DEFAULT_MAX_EDITS = 1000;
export const DEFAULT_MAX_LINES = 20_000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The edit script as a flat list of line operations, or a whole-file
// replacement when the inputs are too large or too different to diff
// minimally within budget. `minimal` reports which of the two it is.
export function diffLines(
  a: string[],
  b: string[],
  options: UnifiedDiffOptions = {},
): { lines: DiffLine[]; minimal: boolean } {
  const maxEdits = options.maxEdits ?? DEFAULT_MAX_EDITS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (a.length > maxLines || b.length > maxLines)
    return { lines: replaceAll(a, b), minimal: false };
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  // Past the budget, the shared prefix and suffix are still kept: only the
  // middle degrades to a replacement.
  const middle = myers(midA, midB, maxEdits);
  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) lines.push({ op: " ", text: a[i]! });
  lines.push(...(middle || replaceAll(midA, midB)));
  for (let i = a.length - suffix; i < a.length; i += 1)
    lines.push({ op: " ", text: a[i]! });
  return { lines, minimal: middle !== null };
}

function replaceAll(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text) => ({ op: "-" as const, text })),
    ...b.map((text) => ({ op: "+" as const, text })),
  ];
}

// Forward Myers with per-round snapshots of the furthest-reaching x for each
// diagonal, then a backtrack over those snapshots. Snapshot d covers the
// diagonals [-d-1, d+1] the backtrack can touch, so memory is O(D^2) ints
// rather than O((N+M)·D). Returns null once D exceeds maxEdits.
function myers(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((text) => ({ op: "+" as const, text }));
  if (!m) return a.map((text) => ({ op: "-" as const, text }));
  const max = Math.min(n + m, maxEdits);
  // v[k + offset] = furthest x on diagonal k; sized for k in [-max-1, max+1].
  const offset = max + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d += 1) {
    // Snapshot before this round: diagonals [-d-1, d+1], stored at index
    // k + d + 1. Unvisited diagonals read as 0 (matches the v[1] = 0 seed).
    const snap = new Int32Array(2 * d + 3);
    for (let k = -d - 1; k <= d + 1; k += 1) snap[k + d + 1] = v[k + offset]!;
    trace.push(snap);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!))
        x = v[k + 1 + offset]!;
      else x = v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: " ", text: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: "+", text: b[y - 1]! });
      else out.push({ op: "-", text: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

// A unified diff between two texts, or "" when they are identical. Hunk
// headers follow GNU diff (`,1` omitted, empty ranges anchored on the line
// before the change).
export function unifiedDiff(
  fromText: string,
  toText: string,
  fromLabel: string,
  toLabel: string,
  options: UnifiedDiffOptions = {},
): string {
  const context = Math.max(0, options.context ?? 3);
  const a = splitLines(fromText);
  const b = splitLines(toText);
  const { lines } = diffLines(a, b, options);
  const changes: number[] = [];
  for (let i = 0; i < lines.length; i += 1)
    if (lines[i]!.op !== " ") changes.push(i);
  if (!changes.length) return "";
  // Running line offsets so each hunk can name its start lines.
  const aBefore = new Int32Array(lines.length + 1);
  const bBefore = new Int32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i += 1) {
    const op = lines[i]!.op;
    aBefore[i + 1] = aBefore[i]! + (op === "+" ? 0 : 1);
    bBefore[i + 1] = bBefore[i]! + (op === "-" ? 0 : 1);
  }
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let g = 0;
  while (g < changes.length) {
    let last = g;
    while (
      last + 1 < changes.length &&
      changes[last + 1]! - changes[last]! <= 2 * context + 1
    )
      last += 1;
    const start = Math.max(0, changes[g]! - context);
    const end = Math.min(lines.length - 1, changes[last]! + context);
    const aCount = aBefore[end + 1]! - aBefore[start]!;
    const bCount = bBefore[end + 1]! - bBefore[start]!;
    out.push(
      `@@ -${range(aBefore[start]!, aCount)} +${range(bBefore[start]!, bCount)} @@`,
    );
    for (let i = start; i <= end; i += 1)
      out.push(`${lines[i]!.op}${lines[i]!.text}`);
    g = last + 1;
  }
  return out.join("\n") + "\n";
}

function range(before: number, count: number): string {
  const start = count ? before + 1 : before;
  return count === 1 ? String(start) : `${start},${count}`;
}
