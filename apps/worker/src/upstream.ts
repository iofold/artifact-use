// Upstream proxy: the reserved `_api/` path under an artifact URL forwards to
// the one HTTPS backend a creator configured for that artifact. servePublic
// has already enforced the artifact gate by the time this runs, so the
// backend sees only viewers who passed it — the request arrives with the
// stored bearer secret plus the viewer's gate identity, and the published
// page never holds a credential of its own.
import type { Artifact, ArtifactUpstream, Env, ViewerSession } from "./types";
import { getArtifactUpstream } from "./db";
import { requestIp } from "./rl";
import { error, siteBaseUrl } from "./util";

export const UPSTREAM_SEGMENT = "_api";
export const UPSTREAM_PATH = /\/_api(\/|$)/;

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
];
// Allowlist rather than denylist: the upstream's cookies, CORS, security and
// transport headers belong to its origin, not to the artifact host.
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-language",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "retry-after",
  "vary",
  "x-request-id",
];

// Validate and normalize a creator-supplied upstream base URL. Only public
// HTTPS hosts: no credentials, query, or fragment; no IP literals, loopback,
// or link-local names; never the artifact host itself.
export function normalizeUpstreamUrl(value: string, env: Env): string | null {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith("[") || /^[0-9.]+$/.test(host)) return null;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa")
  )
    return null;
  try {
    if (host === new URL(siteBaseUrl(env)).hostname.toLowerCase()) return null;
  } catch {
    // no site host to compare against
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function upstreamSummary(
  upstream: ArtifactUpstream | null,
  artifactPath: string,
): {
  base_url: string;
  path: string;
  has_secret: boolean;
  updated_at: number;
} | null {
  if (!upstream) return null;
  return {
    base_url: upstream.base_url,
    path: `${artifactPath}${UPSTREAM_SEGMENT}/`,
    has_secret: !!upstream.secret,
    updated_at: upstream.updated_at,
  };
}

export async function proxyUpstream(
  request: Request,
  env: Env,
  artifact: Artifact,
  session: ViewerSession | null,
  rest: string[],
): Promise<Response> {
  if (!METHODS.has(request.method))
    return error(405, "method_not_allowed", "method not allowed");
  const upstream = await getArtifactUpstream(env, artifact.id);
  if (!upstream)
    return error(404, "no_upstream", "this artifact has no upstream backend");
  const target = new URL(
    `${upstream.base_url}/${rest.join("/")}${new URL(request.url).search}`,
  );

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (upstream.secret)
    headers.set("Authorization", `Bearer ${upstream.secret}`);
  headers.set("X-Artifact-Key", artifact.url_key);
  headers.set("X-Artifact-Viewer-Email", session?.email || "");
  headers.set("X-Artifact-Viewer-Verified", session?.verified ? "1" : "0");
  headers.set("X-Artifact-Viewer-Id", session ? String(session.view_id) : "");
  headers.set("X-Forwarded-For", requestIp(request));

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BODY_BYTES)
      return error(413, "body_too_large", "request body exceeds 10 MiB");
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES)
      return error(413, "body_too_large", "request body exceeds 10 MiB");
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (body) init.body = body;
  let response: Response;
  try {
    response = await fetch(target.toString(), init);
  } catch (e) {
    // Say why: the operator debugging a 502 needs the runtime's reason
    // (DNS, TLS, connection refused), which never includes the secret.
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    const reason = e instanceof Error ? e.message : String(e);
    return error(
      timedOut ? 504 : 502,
      timedOut ? "upstream_timeout" : "upstream_unreachable",
      timedOut
        ? `the upstream backend did not answer in time (${reason})`
        : `the upstream backend could not be reached (${reason})`,
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("Cache-Control", "private, no-store");
  out.set("X-Artifact-Upstream", "1");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}
