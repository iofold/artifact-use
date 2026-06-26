// Minifies src/widget/feedback.js into src/widget/feedback.generated.ts as a
// string constant the worker imports. Run by wrangler [build] (dev + deploy)
// and by `npm run build`. Deterministic output so the generated file can be
// committed and diffed.
import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "..", "src", "widget");
const entry = path.join(dir, "feedback.js");
const out = path.join(dir, "feedback.generated.ts");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2019",
  legalComments: "none",
  write: false,
});

const code = result.outputFiles[0].text.trim();
const header =
  "// AUTO-GENERATED from src/widget/feedback.js by " +
  "scripts/build-feedback-widget.mjs — do not edit.\n";
const body = `export const FEEDBACK_WIDGET_JS = ${JSON.stringify(code)};\n`;

const next = header + body;
let prev = "";
try {
  prev = readFileSync(out, "utf8");
} catch {}
if (prev !== next) {
  writeFileSync(out, next);
  console.log(
    `[feedback-widget] wrote ${path.relative(process.cwd(), out)} (${code.length} bytes minified)`,
  );
} else {
  console.log("[feedback-widget] up to date");
}
