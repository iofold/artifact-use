#!/usr/bin/env node
// Tool-schema token budget.
//
// Every MCP client pastes the full tools/list result into the model's context
// at the start of every session, so schema bytes are a per-session tax on
// every user. The most-upvoted community post about Anthropic's own artifact
// tool is developers disabling it because its schema costs 10-20k tokens per
// session. Artifact Use must never give anyone that reason: the whole list
// stays under 12,000 bytes and no single tool over 4,000 bytes (roughly 3,000
// and 1,000 tokens at ~4 bytes per token). Fails with exit 1 when a budget is
// exceeded; prints per-tool byte counts and token estimates otherwise.
//
// Run with `npm run check:schema` (node --import tsx, so the TypeScript
// source of packages/client-core is measured directly, never a stale build).

import {
  artifactCommentsTool,
  artifactManageTool,
  artifactPublishLocalTool,
  artifactPublishTool,
  artifactUploadSessionTool,
} from "../../../packages/client-core/src/schemas.ts";

const TOTAL_LIMIT = 12_000;
const TOOL_LIMIT = 4_000;
const BYTES_PER_TOKEN = 4;

// The hosted /mcp endpoint lists the base tools; the stdio server swaps in
// the local publish tool (dir / dry_run inputs). Both lists must fit.
const SURFACES = {
  "hosted /mcp": [
    artifactPublishTool,
    artifactUploadSessionTool,
    artifactManageTool,
    artifactCommentsTool,
  ],
  "stdio server": [
    artifactPublishLocalTool,
    artifactUploadSessionTool,
    artifactManageTool,
    artifactCommentsTool,
  ],
};

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const tokens = (n) => Math.ceil(n / BYTES_PER_TOKEN);
const pad = (value, width) => String(value).padStart(width);

const failures = [];
const seen = new Set();
console.log(
  `${"tool".padEnd(32)}${pad("bytes", 7)}${pad("~tokens", 9)}${pad("limit", 7)}`,
);
for (const tools of Object.values(SURFACES)) {
  for (const tool of tools) {
    const label =
      tool === artifactPublishLocalTool ? `${tool.name} (stdio)` : tool.name;
    if (seen.has(label)) continue;
    seen.add(label);
    const size = bytes(tool);
    console.log(
      `${label.padEnd(32)}${pad(size, 7)}${pad(tokens(size), 9)}${pad(TOOL_LIMIT, 7)}`,
    );
    if (size > TOOL_LIMIT)
      failures.push(`${label} is ${size} bytes (limit ${TOOL_LIMIT})`);
  }
}
for (const [surface, tools] of Object.entries(SURFACES)) {
  // Serialised exactly as a tools/list result body: { tools: [...] }.
  const size = bytes({ tools });
  console.log(
    `${`tools/list (${surface})`.padEnd(32)}${pad(size, 7)}${pad(tokens(size), 9)}${pad(TOTAL_LIMIT, 7)}`,
  );
  if (size > TOTAL_LIMIT)
    failures.push(
      `tools/list for ${surface} is ${size} bytes (limit ${TOTAL_LIMIT})`,
    );
}

if (failures.length) {
  console.error("\nTool schema budget exceeded:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nTrim descriptions or fold rarely used inputs before growing the schema; every byte is paid on every session.",
  );
  process.exit(1);
}
console.log("\nOK: tool schemas are within budget.");
