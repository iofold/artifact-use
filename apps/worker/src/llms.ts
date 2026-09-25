import type { Env } from "./types";
import { artifactPathPrefix, siteBaseUrl } from "./util";
// Generated from docs/agent-guide.md by scripts/build-llms.mjs (wrangler
// [build], `npm run build`, `npm run typecheck`). Edit the markdown, not this.
import {
  AGENT_GUIDE_FULL,
  AGENT_GUIDE_SHORT,
  BASE_TOKEN,
  PREFIX_TOKEN,
} from "./llms.generated";

// Short index: the blocks of the guide marked for /llms.txt (what the service
// is, one setup path per harness, the tools, and how to read a gated
// artifact), framed with a title and the pointer to the full guide.
export function llmsTxt(env: Env): Response {
  const base = siteBaseUrl(env);
  return text(
    `# Artifact Use\n\n${render(AGENT_GUIDE_SHORT, env)}\nFull guide: ${base}/llms-full.txt\n`,
  );
}

export function llmsFullTxt(env: Env): Response {
  return text(render(AGENT_GUIDE_FULL, env));
}

// The guide is authored against the hosted deployment; substitute this
// deployment's base URL and artifact path prefix.
function render(template: string, env: Env): string {
  return template
    .split(BASE_TOKEN)
    .join(siteBaseUrl(env))
    .split(PREFIX_TOKEN)
    .join(artifactPathPrefix(env));
}

// Short, harness-neutral handoff: the creator token appears once and all
// client-specific setup stays behind the stable /llms.txt pointer.
export function agentSetupPrompt(
  env: Env,
  token: string,
  expiresAt: number,
): string {
  const base = siteBaseUrl(env);
  const expires = new Date(expiresAt * 1000).toISOString();
  return [
    `Connect this agent to Artifact Use at ${base}.`,
    `Creator token (publish + manage, expires ${expires}):`,
    token,
    `Read ${base}/llms.txt, identify the current harness, and follow exactly one matching setup path.`,
    `Prefer hosted MCP; use this token only when that path requires bearer auth.`,
    `If a call fails with token_expired, ask me for a fresh token from ${base}/admin/connect.`,
    `Keep the token out of repositories, logs, and published artifacts.`,
  ].join("\n");
}

function text(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
