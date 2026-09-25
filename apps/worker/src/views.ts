// What a view is. The dashboard used to count gate passes: public artifacts
// showed zero views forever, the operator's own headless QA runs and curl
// checks were a quarter of the total, and nothing told a publisher whether a
// person or a script had looked. Every view row now carries a kind (who) and
// a source (how it got in), decided here at insert time, and a public
// artifact's HTML counts a person once per day.
import type { Artifact, Env } from "./types";
import { readCookie } from "./auth";
import { insertView, viewerIpHash } from "./db";
import { clientFromUserAgent } from "./events";
import { getPublisherSessionAuth } from "./publisher";
import { resolveWorkspaceOrg } from "./workspaces";
import { bearerToken, publicArtifactPath, wantsHtml } from "./util";

export type ViewKind = "human" | "agent" | "automation";
export type ViewSource = "gate" | "link" | "public" | "session";

export const VIEW_KINDS: readonly ViewKind[] = ["human", "agent", "automation"];

// Coding agents and assistants fetching a page for themselves. Checked before
// the automation families because some carry a browser prefix (ChatGPT-User)
// or a Node runtime suffix. Hypermodel-* are the operator's own tools.
const AGENT_UA =
  /claude-code|codex|^Claude-User|ChatGPT-User|hermes|opencode|cursor|kiro|^Hypermodel-/i;

// Headless browsers, HTTP clients and link unfurlers: nobody is reading.
const AUTOMATION_UA =
  /HeadlessChrome|curl\/|python-requests|python-httpx|Python-urllib|aiohttp|^node$|^node[/-]|undici|Bun\/|Go-http-client|Wget\/|Slackbot|facebookexternalhit|Twitterbot|WhatsApp|TelegramBot|Discordbot|LinkedInBot/i;

const AGENT_CLIENTS = new Set([
  "claude-code",
  "claude-ai",
  "codex",
  "opencode",
  "hermes",
  "cursor",
  "kiro",
]);
const AUTOMATION_CLIENTS = new Set([
  "python-httpx",
  "python-requests",
  "python-urllib",
  "aiohttp",
  "bun",
  "node",
  "curl",
  "go",
]);

// Who is behind a User-Agent. `human` is the fallback, so an unknown client
// counts as a person: the families above are the ones observed in traffic,
// and a scanner wearing a browser UA is indistinguishable from a browser. An
// empty UA is never a browser.
export function classifyViewer(ua: string | null | undefined): ViewKind {
  const value = (ua || "").trim();
  if (!value) return "automation";
  if (AGENT_UA.test(value)) return "agent";
  if (AUTOMATION_UA.test(value)) return "automation";
  // Same vocabulary as the MCP activity feed, so a harness that shows up
  // there is never a "person" here.
  const { client } = clientFromUserAgent(value);
  if (AGENT_CLIENTS.has(client)) return "agent";
  if (AUTOMATION_CLIENTS.has(client)) return "automation";
  return "human";
}

// One public view per person per day: the cookie is the window, scoped to
// the artifact's own path so it never rides on other artifacts' requests.
export const SEEN_WINDOW_SEC = 24 * 60 * 60;

export function seenCookieName(artifactId: string): string {
  return `au_seen_${artifactId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

export function seenCookie(env: Env, artifact: Artifact): string {
  return `${seenCookieName(artifact.id)}=1; Path=${publicArtifactPath(
    env,
    artifact.url_key,
  )}; Max-Age=${SEEN_WINDOW_SEC}; Secure; HttpOnly; SameSite=Lax`;
}

function isHtmlResponse(response: Response): boolean {
  const type = response.headers.get("Content-Type") || "";
  return type.split(";")[0]?.trim().toLowerCase() === "text/html";
}

// The publisher's own signed-in session (any workspace they belong to that
// owns the artifact). A member opening their own public artifact is not an
// audience.
async function publisherOwnsArtifact(
  request: Request,
  env: Env,
  artifact: Artifact,
): Promise<boolean> {
  const auth = await getPublisherSessionAuth(request, env);
  if (!auth) return false;
  if (auth.session.orgId === artifact.org_id) return true;
  try {
    await resolveWorkspaceOrg(env, auth.session.sub, artifact.org_id);
    return true;
  } catch {
    return false;
  }
}

// Wraps the response to a public artifact's page. Records a view when a
// person's browser is served HTML for the first time in the cookie window;
// never for assets, agents or automation, workspace credentials, or the
// publisher's own session. Identity is `public:<ip hash>` because nothing
// was asked of the viewer. Analytics never fails a request: an insert error
// leaves the response (and the cookie) untouched, so the next load retries.
export async function recordPublicView(
  request: Request,
  env: Env,
  artifact: Artifact,
  response: Response,
): Promise<Response> {
  if (artifact.gate_level !== "public") return response;
  if (request.method !== "GET" || response.status !== 200) return response;
  if (!isHtmlResponse(response) || !wantsHtml(request)) return response;
  if (classifyViewer(request.headers.get("User-Agent")) !== "human")
    return response;
  if (readCookie(request, seenCookieName(artifact.id))) return response;
  // A bearer on a page request is a token read (creator, OAuth, viewer
  // session), never a person navigating.
  if (bearerToken(request)) return response;
  if (await publisherOwnsArtifact(request, env, artifact)) return response;
  try {
    const ipHash = (await viewerIpHash(request)) || "unknown";
    await insertView(env, artifact, null, `public:${ipHash}`, false, request, {
      kind: "human",
      source: "public",
    });
  } catch {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", seenCookie(env, artifact));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
