import type {
  Artifact,
  ArtifactVersion,
  Creator,
  Env,
  PublishManifest,
  ViewerSession,
} from "./types";
import { abuseMailto } from "./abuse";
import { getCreator, requirePermission, signViewerSession } from "./auth";
import { resolveWorkspaceOrg } from "./workspaces";
import {
  type CommentAuthor,
  agentPresence,
  clampWait,
  createComment,
  creatorCommentAuthor,
  listComments,
  markSentToAgent,
  positiveInteger,
  reanchorComment,
  resolveComment,
  touchArtifactWatch,
  waitForComments,
} from "./comments";
import {
  getArtifactByLegacyPath,
  getArtifactByUrlKey,
  getFile,
  getShareLink,
  getVersion,
} from "./db";
import {
  deadLinkResponse,
  getViewerSession,
  issueViewerSession,
  mintViewerSession,
  renderGate,
  renderPasscodeGate,
  resolveLinkAccess,
  signedInViewer,
} from "./gate";
import { type ShareLink, shareLinkIdentity, shareLinkKind } from "./links";
import { getPublisherSessionAuth } from "./publisher";
import { unavailableArtifactResponse } from "./moderation";
import {
  injectArtifactMetadata,
  isLinkPreviewRequest,
  renderArtifactPreviewDocument,
} from "./preview";
import { commentWriteRateLimit, rateLimitedResponse } from "./rl";
import { UPSTREAM_SEGMENT, proxyUpstream } from "./upstream";
import { FEEDBACK_WIDGET_JS } from "./widget/feedback.generated";
import {
  bearerToken,
  error,
  json,
  mimeFor,
  nowSec,
  publicArtifactPath,
  publicArtifactUrl,
  requiresVerified,
  siteBaseUrl,
  stripPublicArtifactPrefix,
  validateAssetPath,
  wantsHtml,
} from "./util";

const COMMON_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

export async function servePublic(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const publicPath = stripPublicArtifactPrefix(env, path);
  if (publicPath === null) return error(404, "not_found", "not found");
  const parts = publicPath.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!parts.length) return landing(env);
  const [urlKey, legacySlug, ...legacyRest] = parts;
  let artifact = await getArtifactByUrlKey(env, urlKey || "");
  let rest = artifact ? parts.slice(1) : legacyRest;
  if (!artifact && legacySlug) {
    artifact = await getArtifactByLegacyPath(env, urlKey || "", legacySlug);
    if (artifact) {
      const unavailable = unavailableArtifactResponse(request, artifact);
      if (unavailable) return unavailable;
      const url = new URL(request.url);
      url.pathname = publicArtifactPath(env, artifact.url_key) + rest.join("/");
      return Response.redirect(url.toString(), 301);
    }
  }
  if (!artifact || !artifact.current_version_id)
    return error(404, "artifact_not_found", "artifact not found");
  const unavailable = unavailableArtifactResponse(request, artifact);
  if (unavailable) return unavailable;
  if (
    (rest.length === 1 && rest[0] === artifact.slug) ||
    (rest.length === 0 && !path.endsWith("/"))
  ) {
    const url = new URL(request.url);
    url.pathname = publicArtifactPath(env, artifact.url_key);
    return Response.redirect(url.toString(), 301);
  }
  const linkPreview = isLinkPreviewRequest(request);
  // Reserved sub-path: gated viewers' requests to the creator's upstream
  // backend. Never HTML, never a file lookup; the gate below still applies.
  const isUpstream = rest[0] === UPSTREAM_SEGMENT;
  let session: ViewerSession | null = null;
  // Set when this very request minted a session (a share link passed
  // inline); the cookie rides on whatever response the serving tail builds.
  let sessionCookie: string | null = null;
  if (artifact.gate_level !== "public") {
    session = await linkSessionStillValid(
      env,
      artifact,
      await getViewerSession(request, env, artifact),
    );
    // Agents of the publishing workspace read what they published with the
    // token they already hold: no viewer session, no view row. Reads only,
    // and never the upstream proxy, which needs a viewer identity.
    const creatorRead =
      !session &&
      !isUpstream &&
      (request.method === "GET" || request.method === "HEAD") &&
      (await creatorForArtifact(request, env, artifact, "artifacts:read")) !==
        null;
    if (!sessionPassesGate(artifact, session) && !creatorRead) {
      if (linkPreview) {
        return headOnly(
          request,
          renderArtifactPreviewDocument(
            env,
            artifact,
            await entrypointContentType(env, artifact),
          ),
        );
      }
      const url = new URL(request.url);
      // Share links are the publisher's explicit grant: `?v=<id>` (or a
      // Basic username) selects one, and its kind decides what happens next.
      const access = await resolveLinkAccess(
        request,
        env,
        artifact,
        url.searchParams.get("v"),
      );
      if (access.kind === "dead")
        return deadLinkResponse(request, artifact, access.state);
      if (access.kind === "limited")
        return rateLimitedResponse(access.limit, request, artifact.title);
      if (access.kind === "pass") {
        const identity = shareLinkIdentity(access.link);
        if (wantsHtml(request) && request.method === "GET") {
          // Browsers bounce to the same URL minus the link id so the
          // credential never lingers in the address bar or copied links.
          const back = new URL(url);
          back.searchParams.delete("v");
          back.searchParams.delete("au_sso");
          return issueViewerSession(
            request,
            env,
            artifact,
            identity,
            false,
            access.link.id,
            `${back.pathname}${back.search}${back.hash}`,
            true,
          );
        }
        const minted = await mintViewerSession(
          request,
          env,
          artifact,
          identity,
          false,
          access.link.id,
          true,
        );
        session = minted.session;
        sessionCookie = minted.cookie;
      } else if (access.kind === "passcode") {
        if (isUpstream || !wantsHtml(request))
          return gateJson(env, artifact, access.link);
        const keep = new URLSearchParams(url.search);
        keep.delete("v");
        keep.delete("au_sso");
        const gate = renderPasscodeGate(
          artifact,
          keep.size ? `${path}?${keep}` : path,
          access.link.id,
          access.wrong ? "That passcode is not right." : "",
        );
        return gatePage(request, env, artifact, gate);
      } else {
        // Machine-readable gate: a non-browser fetch gets a 401 + JSON
        // describing how to get in, instead of a 200 HTML email form.
        if (isUpstream || !wantsHtml(request)) return gateJson(env, artifact);
        // Signed-in members of the artifact's workspace skip the gate: their
        // WorkOS login already proves the email the gate would collect, at a
        // strictly higher bar than the OTP. `au_sso=1` marks the
        // cookie-setting bounce — if it comes back sessionless (cookies
        // blocked), the manual gate renders instead of redirect-looping.
        // Non-members fall through to the gate page, where their signed-in
        // email becomes a one-click consent rather than a silent pass.
        const signedIn =
          request.method === "GET"
            ? await signedInViewer(request, env, artifact)
            : null;
        if (signedIn?.member && url.searchParams.get("au_sso") !== "1") {
          const bounce = new URL(url);
          bounce.searchParams.set("au_sso", "1");
          return issueViewerSession(
            request,
            env,
            artifact,
            signedIn.email,
            true,
            null,
            `${bounce.pathname}${bounce.search}${bounce.hash}`,
          );
        }
        // Send the viewer back to the exact URL they asked for once the gate
        // passes: artifacts keep state in the query string, and losing it
        // here silently reset that state. The SSO bounce marker and any
        // stale link id are consumed here and stay out of the redirect.
        const keep = new URLSearchParams(url.search);
        keep.delete("v");
        keep.delete("au_sso");
        const gate = renderGate(
          artifact,
          keep.size ? `${path}?${keep}` : path,
          "",
          "",
          signedIn?.email || "",
        );
        return gatePage(request, env, artifact, gate);
      }
    }
  }
  // The gate passed; drop the SSO bounce marker so it never lingers in the
  // address bar or in copied links.
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.has("au_sso")) {
    requestUrl.searchParams.delete("au_sso");
    return Response.redirect(requestUrl.toString(), 302);
  }
  const response = isUpstream
    ? await proxyUpstream(request, env, artifact, session, rest.slice(1))
    : await serveVersion(request, env, artifact, publicPath, rest);
  return sessionCookie ? withCookie(response, sessionCookie) : response;
}

// The gate page, with the artifact's public metadata injected so a shared
// link still unfurls while the content stays behind the gate.
async function gatePage(
  request: Request,
  env: Env,
  artifact: Artifact,
  gate: Response,
): Promise<Response> {
  const gateHtml = injectArtifactMetadata(
    await gate.text(),
    env,
    artifact,
    await entrypointContentType(env, artifact),
  );
  return new Response(request.method === "HEAD" ? null : gateHtml, {
    status: gate.status,
    statusText: gate.statusText,
    headers: gate.headers,
  });
}

// A verified gate wants a verified session, unless a validated share link
// minted it: the link is the publisher's grant and outranks the OTP.
function sessionPassesGate(
  artifact: Artifact,
  session: ViewerSession | null,
): session is ViewerSession {
  if (!session) return false;
  if (!requiresVerified(artifact.gate_level)) return true;
  return session.verified || Boolean(session.link_id);
}

// A session minted through a share link stops working when the link is
// revoked or expires, not 30 days later. Reaching the open limit does not
// cut off sessions already issued: the last permitted opener would otherwise
// lose access on their very next request.
async function linkSessionStillValid(
  env: Env,
  artifact: Artifact,
  session: ViewerSession | null,
): Promise<ViewerSession | null> {
  if (!session?.link_id) return session;
  const link = await getShareLink(env, artifact.id, session.link_id);
  if (!link || link.revoked_at) return null;
  if (link.expires_at && link.expires_at < nowSec()) return null;
  return session;
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Everything after the gate: the file lookup, range and conditional handling,
// widget injection.
async function serveVersion(
  request: Request,
  env: Env,
  artifact: Artifact,
  publicPath: string,
  rest: string[],
): Promise<Response> {
  if (!artifact.current_version_id)
    return error(404, "version_not_found", "artifact version not found");
  const linkPreview = isLinkPreviewRequest(request);
  const version = await getVersion(env, artifact.current_version_id);
  if (!version || version.status !== "complete")
    return error(404, "version_not_found", "artifact version not found");
  // Machine descriptor at the reserved `_au/index.json` path (gate already
  // enforced above) — structure for agents without scraping HTML.
  if (rest.length === 2 && rest[0] === "_au" && rest[1] === "index.json")
    return artifactDescriptor(env, artifact, version);
  // `rest` never carries a trailing slash (split+filter drops the empty
  // segment), so directory-style URLs are detected from the raw request path.
  let assetPath = rest.join("/") || version.entrypoint || "index.html";
  if (rest.length && publicPath.endsWith("/")) assetPath += "/index.html";
  try {
    assetPath = validateAssetPath(assetPath);
  } catch {
    // Reserved (`_au/…`, `_iof/…`, `cdn-cgi`) or malformed segments under an
    // artifact URL are files that do not exist. Letting the validation error
    // propagate surfaced it to real viewers as `500 internal_error` whenever a
    // page linked `_au/comments` relative to its own path.
    return error(404, "file_not_found", "file not found");
  }
  const row = await getFile(env, version.id, assetPath);
  if (!row) return error(404, "file_not_found", "file not found");
  const rowType = row.content_type || mimeFor(row.path);
  if (linkPreview) {
    return headOnly(
      request,
      renderArtifactPreviewDocument(env, artifact, rowType),
    );
  }
  const isHtmlPath =
    mediaType(rowType) === "text/html" || /\.html?$/i.test(row.path);
  const getOptions: R2GetOptions = {};
  // HTML responses strip ETag/Last-Modified and inject the feedback widget, so
  // they must never short-circuit to 304/412.
  if (!isHtmlPath) getOptions.onlyIf = request.headers;
  const rangeHeaders = await r2RangeHeaders(
    env,
    row.storage_key,
    request,
    isHtmlPath,
  );
  if (rangeHeaders) getOptions.range = rangeHeaders;
  const obj = await env.BUCKET.get(row.storage_key, getOptions);
  if (!obj) return error(404, "object_not_found", "object not found");
  const contentType =
    obj.httpMetadata?.contentType || row.content_type || mimeFor(row.path);
  const isHtml = isHtmlPath || mediaType(contentType) === "text/html";
  const headers = objectHeaders(
    obj,
    contentType,
    artifact.gate_level,
    isHtml,
    row.path,
  );
  if (!("body" in obj))
    return new Response(null, {
      status: preconditionFailed(request.headers) ? 412 : 304,
      headers,
    });
  const bodyObj = obj as R2ObjectBody;
  if (isHtml) {
    headers.delete("ETag");
    headers.delete("Last-Modified");
    // Point agents at the machine descriptor.
    headers.set(
      "Link",
      `<${publicArtifactUrl(env, artifact.url_key)}_au/index.json>; rel="describedby"; type="application/json"`,
    );
    if (request.method === "HEAD") return new Response(null, { headers });
    const html = injectArtifactMetadata(
      await bodyObj.text(),
      env,
      artifact,
      contentType,
    );
    // Only inject the feedback widget for real browsers; agents get clean HTML.
    const body = wantsHtml(request)
      ? injectWidget(html, artifact, version.id, env)
      : html;
    return new Response(body, { headers });
  }
  const range = rangeHeaders ? rangeBounds(bodyObj.range, obj.size) : null;
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${obj.size}`,
    );
    headers.set("Content-Length", String(range.length));
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Range");
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : bodyObj.body, {
    status: range ? 206 : 200,
    headers,
  });
}

async function entrypointContentType(
  env: Env,
  artifact: Artifact,
): Promise<string> {
  if (!artifact.current_version_id) return "application/octet-stream";
  const version = await getVersion(env, artifact.current_version_id);
  if (!version || version.status !== "complete")
    return "application/octet-stream";
  const file = await getFile(
    env,
    version.id,
    version.entrypoint || "index.html",
  );
  return file?.content_type || mimeFor(version.entrypoint || "index.html");
}

function headOnly(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function objectHeaders(
  obj: R2Object,
  contentType: string,
  gateLevel: Artifact["gate_level"],
  isHtml: boolean,
  path: string,
): Headers {
  const headers = new Headers(COMMON_HEADERS);
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", cacheControl(gateLevel, isHtml, path));
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  if (!isHtml) {
    headers.set("ETag", obj.httpEtag);
    headers.set("Accept-Ranges", "bytes");
  }
  return headers;
}

// Bundler-emitted assets carry a content hash in the filename (e.g. Vite's
// assets/<name>-<hash>.<ext>), so a given path can never serve different
// bytes — safe to cache as immutable. Gated artifacts still get `private`
// (browser cache only), and HTML stays no-store so gate checks and widget
// injection always run.
const HASHED_ASSET_RE = /(^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

export function cacheControl(
  gateLevel: Artifact["gate_level"],
  isHtml: boolean,
  path: string,
): string {
  if (isHtml) return "private, no-store";
  if (HASHED_ASSET_RE.test(path)) {
    return gateLevel === "public"
      ? "public, max-age=31536000, immutable"
      : "private, max-age=31536000, immutable";
  }
  if (gateLevel !== "public") return "private, no-store";
  return "public, max-age=300, must-revalidate";
}

async function r2RangeHeaders(
  env: Env,
  storageKey: string,
  request: Request,
  isHtml: boolean,
): Promise<Headers | undefined> {
  if (request.method !== "GET" || isHtml || !request.headers.has("Range"))
    return undefined;
  const ifRange = request.headers.get("If-Range");
  if (!ifRange) return request.headers;
  const head = await env.BUCKET.head(storageKey);
  if (!head || !ifRangeMatches(ifRange, head)) return undefined;
  return request.headers;
}

function ifRangeMatches(value: string, obj: R2Object): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return trimmed === obj.httpEtag;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && obj.uploaded.getTime() <= date;
}

function preconditionFailed(headers: Headers): boolean {
  return headers.has("If-Match") || headers.has("If-Unmodified-Since");
}

function mediaType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || "";
}

function rangeBounds(
  range: R2Range | undefined,
  size: number,
): { start: number; end: number; length: number } | null {
  if (!range) return null;
  if ("suffix" in range && typeof range.suffix === "number") {
    const length = Math.min(range.suffix, size);
    return { start: size - length, end: size - 1, length };
  }
  const byteRange = range as { offset?: number; length?: number };
  const start = typeof byteRange.offset === "number" ? byteRange.offset : 0;
  const length = byteRange.length ?? Math.max(0, size - start);
  return { start, end: start + length - 1, length };
}

// Read-only role probe for the injected widget: is this browser a publisher
// of the artifact it is viewing? Publishers get a deep link into their admin
// sidesheet; everyone else gets an identical minimal "viewer" response. The
// response deliberately carries nothing else — the widget shares a JS realm
// with untrusted artifact content, so no stats, emails, or capability URLs.
export async function handleArtifactContext(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET")
    return error(405, "method_not_allowed", "method not allowed");
  const url = new URL(request.url);
  const artifact = await getArtifactByUrlKey(
    env,
    url.searchParams.get("artifact_key") || "",
  );
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  if (artifact.status !== "active" || artifact.org_suspended)
    return json({ role: "viewer" });
  // Agent presence is page-level, not identity-level: every viewer may know
  // whether the publishing agent has checked this artifact recently.
  const agent = await agentPresence(env, artifact.id);
  const viewer = () => json({ role: "viewer", agent });
  const auth = await getPublisherSessionAuth(request, env);
  if (!auth || auth.session.orgId !== artifact.org_id) return viewer();
  // Defense-in-depth: an artifact page may only ask about itself, so hostile
  // artifact JS cannot probe a visiting publisher's other artifacts.
  if (refererOutsideArtifact(request, env, artifact)) return viewer();
  return json({
    role: "publisher",
    admin_url: `/admin?open=${encodeURIComponent(artifact.id)}`,
    agent,
  });
}

export async function handleComments(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if (path !== "/_au/comments")
    return error(404, "not_found", "comments route not found");
  if (request.method === "GET") {
    const url = new URL(request.url);
    const artifact = await getArtifactByUrlKey(
      env,
      url.searchParams.get("artifact_key") || "",
    );
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const unavailable = unavailableArtifactResponse(request, artifact);
    if (unavailable) return unavailable;
    const author = await commentIdentity(request, env, artifact, "read");
    // Public artifacts allow open reading; gated ones still require a viewer
    // session or a workspace credential.
    if (!author && artifact.gate_level !== "public")
      return commentsUnauthorized(env, artifact, "read");
    // The publishing agent reading through this route counts as watching.
    if (author?.creator)
      await touchArtifactWatch(env, artifact, author.label || "agent");
    const filters = {
      status: url.searchParams.get("status"),
      since: Number(url.searchParams.get("since")) || null,
      pagePath: url.searchParams.get("page_path"),
      limit: Number(url.searchParams.get("limit")) || null,
    };
    const wait = clampWait(url.searchParams.get("wait"));
    return json(
      wait
        ? await waitForComments(env, artifact, filters, wait)
        : await listComments(env, artifact, filters),
    );
  }
  if (request.method === "POST") {
    const body = (await request.json()) as {
      artifact_key?: string;
      body?: string;
      target?: unknown;
      parent_id?: unknown;
      page_path?: unknown;
      version_id?: unknown;
      client_ref?: unknown;
    };
    const artifact = await getArtifactByUrlKey(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const unavailable = unavailableArtifactResponse(request, artifact);
    if (unavailable) return unavailable;
    const author = await commentIdentity(request, env, artifact, "write");
    if (!author) return commentsUnauthorized(env, artifact, "write");
    const limited = await commentWriteRateLimit(request, env, author.email);
    if (limited) return limited;
    const result = await createComment(env, artifact, author, body);
    if (!result.ok) return error(result.status, result.code, result.message);
    return json({ ok: true, comment: result.comment });
  }
  if (request.method === "PATCH") {
    const body = (await request.json()) as {
      artifact_key?: string;
      id?: unknown;
      resolved?: unknown;
      target?: unknown;
      sent_to_agent?: unknown;
    };
    const artifact = await getArtifactByUrlKey(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const unavailable = unavailableArtifactResponse(request, artifact);
    if (unavailable) return unavailable;
    const author = await commentIdentity(request, env, artifact, "write");
    if (!author) return commentsUnauthorized(env, artifact, "write");
    const id = positiveInteger(body.id);
    if (!id) return error(400, "invalid_comment", "comment id is required");
    const limited = await commentWriteRateLimit(request, env, author.email);
    if (limited) return limited;
    // "Send to agent": flag the thread for the publishing agent (fires the
    // comment.sent_to_agent webhook and surfaces under status=sent).
    if (body.sent_to_agent !== undefined) {
      const sent = await markSentToAgent(
        env,
        artifact,
        id,
        body.sent_to_agent !== false,
      );
      if (!sent) return error(404, "comment_not_found", "comment not found");
      return json({ ok: true, comment: sent });
    }
    if (body.target !== undefined) {
      const reanchored = await reanchorComment(env, artifact, id, body.target);
      if (reanchored === null)
        return error(404, "comment_not_found", "comment not found");
      if (reanchored === "invalid_target")
        return error(400, "invalid_target", "target is invalid");
      return json({ ok: true, comment: reanchored });
    }
    const updated = await resolveComment(
      env,
      artifact,
      id,
      body.resolved !== false,
      author.email,
    );
    if (!updated) return error(404, "comment_not_found", "comment not found");
    return json({ ok: true, comment: updated });
  }
  return error(404, "not_found", "comments route not found");
}

// Viewer session (cookie / bearer / ?agent=) first; otherwise a workspace
// credential — creator token or OAuth JWT from the owning org — so the
// publisher's agent can read, reply to, and resolve threads with the token it
// already holds instead of minting a viewer session for its own artifact.
// True when a Referer is present, same-origin, and points OUTSIDE the given
// artifact's path — the shared containment rule keeping hostile artifact JS
// from exercising a visiting publisher's global admin cookie beyond the page
// it runs on. Absent or unparsable referers pass (cross-site callers never
// carry the SameSite=Lax cookie anyway).
function refererOutsideArtifact(
  request: Request,
  env: Env,
  artifact: Artifact,
): boolean {
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    const ref = new URL(referer);
    return (
      ref.origin === new URL(request.url).origin &&
      !ref.pathname.startsWith(publicArtifactPath(env, artifact.url_key))
    );
  } catch {
    return false;
  }
}

// The workspace credential on the request, if it may act on this artifact:
// a creator token or OAuth JWT whose org owns the artifact (a user-scoped
// token qualifies through membership of the artifact's org) and that holds
// the permission. Anything else — including a viewer-session bearer — is
// null, never an error.
async function creatorForArtifact(
  request: Request,
  env: Env,
  artifact: Artifact,
  permission: string,
): Promise<Creator | null> {
  if (!bearerToken(request)) return null;
  try {
    // Lax: the artifact names the workspace here.
    const creator = await getCreator(request, env, { laxWorkspace: true });
    if (!creator) return null;
    if (creator.tokenScope === "user" && !creator.workspaceSelected) {
      await resolveWorkspaceOrg(env, creator.sub, artifact.org_id);
    } else if (creator.orgId !== artifact.org_id) return null;
    requirePermission(creator, env, permission);
    return creator;
  } catch {
    return null;
  }
}

async function commentIdentity(
  request: Request,
  env: Env,
  artifact: Artifact,
  mode: "read" | "write",
): Promise<CommentAuthor | null> {
  const session = await getViewerSession(request, env, artifact);
  if (session) {
    // A delegated "Hand to your agent" session writes as an agent under the
    // viewer's email; a plain gate session is the human viewer.
    return session.agent
      ? {
          email: session.email,
          viewId: session.view_id,
          kind: "agent",
          label: session.agent,
        }
      : { email: session.email, viewId: session.view_id };
  }
  const creator = await creatorForArtifact(
    request,
    env,
    artifact,
    mode === "read" ? "artifacts:read" : "artifacts:publish",
  );
  // The publishing workspace's own credential: the agent, attributed as such.
  if (creator) return creatorCommentAuthor(creator);
  if (bearerToken(request)) return null;
  // Signed-in members of the artifact's workspace comment as themselves —
  // the same trust the admin UI extends — so their own widget never asks for
  // an email. Members only: for anyone else this cookie identity would let a
  // public artifact attribute comments to a visitor who never consented.
  const signedIn = await signedInViewer(request, env, artifact);
  if (signedIn?.member && !refererOutsideArtifact(request, env, artifact))
    return { email: signedIn.email, viewId: null };
  return null;
}

// Machine-readable 401 for the comments route: unlike gateJson this is
// reachable on public artifacts too (posting always needs an identity), so it
// spells out every way in from here.
function commentsUnauthorized(
  env: Env,
  artifact: Artifact,
  mode: "read" | "write",
): Response {
  const site = siteBaseUrl(env);
  const needsOtp = requiresVerified(artifact.gate_level);
  return json(
    {
      error: {
        code: "unauthorized",
        message: `a viewer session or workspace token is required to ${
          mode === "read" ? "read" : "post or resolve"
        } comments`,
      },
      access: {
        bearer:
          "send Authorization: Bearer <viewer-session or workspace token> on this call",
        email_self_serve: !needsOtp
          ? `POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/email with header 'Accept: application/json' to receive a token`
          : null,
        otp_self_serve: needsOtp
          ? `if you can read the inbox: POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/start (the email must be allowlisted for allowlist gates), read the one-time code from that email, then POST form {artifact_key, email, code} to ${site}/_au/gate/verify with header 'Accept: application/json' to receive a token`
          : null,
        delegated: needsOtp
          ? "or ask the human who shared this to use 'Hand to your agent' in the comments widget for a scoped token"
          : null,
        workspace:
          "agents of the publishing workspace: your Artifact Use bearer token (au_creator_... or MCP OAuth) works on this route directly",
        descriptor: `${publicArtifactUrl(env, artifact.url_key)}_au/index.json`,
      },
    },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="artifact-use"' },
    },
  );
}

// The bare artifact prefix (/go, /go/) has no content of its own; send the
// visitor to the real landing page instead of a second, drifting one.
function landing(env: Env): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: siteBaseUrl(env) + "/" },
  });
}

// M2 — machine-readable gate for non-browser fetches. With a password share
// link selected, the passcode routes are spelled out instead.
function gateJson(env: Env, artifact: Artifact, link?: ShareLink): Response {
  const base = publicArtifactUrl(env, artifact.url_key);
  const site = siteBaseUrl(env);
  const isEmail = artifact.gate_level === "email";
  const needsOtp = requiresVerified(artifact.gate_level);
  if (link && shareLinkKind(link) === "password")
    return json(
      {
        error: {
          code: "gate_required",
          message: "this share link requires a passcode",
        },
        gate_level: artifact.gate_level,
        link_kind: "password",
        link_id: link.id,
        access: {
          descriptor: `${base}_au/index.json`,
          passcode_self_serve: `POST form {artifact_key:"${artifact.url_key}", link:"${link.id}", passcode} to ${site}/_au/gate/link with header 'Accept: application/json' to receive a bearer token, then send Authorization: Bearer <token> on every read`,
          basic: `or send Authorization: Basic base64("${link.id}:<passcode>") on each request (a view is recorded per request without the bearer)`,
          workspace:
            "agents of the publishing workspace: your Artifact Use bearer token (au_creator_... or MCP OAuth) reads this artifact directly",
          mcp: `${site}/mcp`,
        },
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="artifact-use"' },
      },
    );
  return json(
    {
      error: {
        code: "gate_required",
        message: "viewer authentication required",
      },
      gate_level: artifact.gate_level,
      access: {
        descriptor: `${base}_au/index.json`,
        bearer:
          "send Authorization: Bearer <viewer-session token> once obtained",
        workspace:
          "agents of the publishing workspace: your Artifact Use bearer token (au_creator_... or MCP OAuth) reads this artifact directly, no viewer session needed",
        email_self_serve: isEmail
          ? `POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/email with header 'Accept: application/json' to receive a token`
          : null,
        otp_self_serve: needsOtp
          ? `if you can read the inbox: POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/start (the email must be allowlisted for allowlist gates), read the one-time code from that email, then POST form {artifact_key, email, code} to ${site}/_au/gate/verify with header 'Accept: application/json' to receive a token`
          : null,
        delegated: needsOtp
          ? "or ask the human who shared this to use 'Hand to your agent' in the comments widget for a scoped token"
          : null,
        mcp: `${site}/mcp`,
      },
      upgrade: `${site}/mcp`,
    },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="artifact-use"' },
    },
  );
}

// M5 — per-artifact machine descriptor (gate already enforced by the caller).
function artifactDescriptor(
  env: Env,
  artifact: Artifact,
  version: ArtifactVersion,
): Response {
  let manifest: PublishManifest | null = null;
  try {
    manifest = version.manifest_json
      ? (JSON.parse(version.manifest_json) as PublishManifest)
      : null;
  } catch {
    manifest = null;
  }
  const base = publicArtifactUrl(env, artifact.url_key);
  const site = siteBaseUrl(env);
  return json({
    url_key: artifact.url_key,
    title: artifact.title,
    description: artifact.description,
    gate_level: artifact.gate_level,
    version_id: version.id,
    entrypoint: version.entrypoint,
    updated_at: artifact.updated_at,
    base,
    files: (manifest?.files || []).map((f) => ({
      path: f.path,
      content_type: f.content_type,
      size: f.size,
      url: base + f.path,
    })),
    read: "GET each file's `url` with header 'Authorization: Bearer <token>'. HTML is fine to read directly; no browser needed.",
    feedback: {
      endpoint: `${site}/_au/comments`,
      auth: "same bearer as reads; the publishing workspace's own token (au_creator_.../MCP OAuth) also works",
      list: `GET ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open|sent|resolved|all&since=<unix>&page_path=<path>&wait=<1..25> -> threaded comments (parent_comment_id links replies to roots); wait long-polls for a comment newer than since and returns next_since to carry`,
      post: {
        method: "POST",
        body: {
          artifact_key: artifact.url_key,
          body: "<your comment>",
          parent_id: "<optional comment id to reply to>",
          target: "<optional element anchor>",
        },
        returns: "the created comment, including its id",
      },
      resolve: {
        method: "PATCH",
        body: {
          artifact_key: artifact.url_key,
          id: "<comment id>",
          resolved: true,
        },
      },
    },
    mcp: `${site}/mcp`,
    upgrade: `${site}/mcp`,
  });
}

// M4 — mint a scoped, short-TTL agent token from an authenticated viewer
// session, plus a ready-to-paste handoff prompt.
export async function handleAgentToken(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST")
    return error(405, "method_not_allowed", "method not allowed");
  const body = (await request.json().catch(() => ({}))) as {
    artifact_key?: string;
  };
  const artifact = await getArtifactByUrlKey(env, body.artifact_key || "");
  if (!artifact) return error(404, "artifact_not_found", "artifact not found");
  const unavailable = unavailableArtifactResponse(request, artifact);
  if (unavailable) return unavailable;
  const base = publicArtifactUrl(env, artifact.url_key);
  const site = siteBaseUrl(env);
  if (artifact.gate_level === "public") {
    // Public: agents read freely, no token. Hand over a no-auth prompt.
    return json({
      token: null,
      token_type: null,
      expires_at: null,
      share_url: base,
      prompt: [
        `This published artifact is public — your agent can read it directly over HTTP (no browser, no auth).`,
        ``,
        `Artifact: "${artifact.title}" — ${base}`,
        ``,
        `1. GET  ${base}_au/index.json   -> title, pages, files, entrypoint, content-types`,
        `2. GET  ${base}<file>           -> any page/asset (HTML is fine to read directly)`,
        `3. GET  ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open   -> read the comment threads`,
        `4. POST ${site}/_au/comments  {artifact_key:"${artifact.url_key}", body, parent_id?, target?}   -> comment or reply; returns the comment id (you'll be asked for an email once)`,
        `5. PATCH ${site}/_au/comments  {artifact_key:"${artifact.url_key}", id, resolved:true}   -> resolve a thread once addressed`,
        ``,
        `Publish your own at ${site}/mcp (sign in once).`,
      ].join("\n"),
    });
  }
  const session = await getViewerSession(request, env, artifact);
  if (!session) return error(401, "unauthorized", "viewer session required");
  if (!sessionPassesGate(artifact, session))
    return error(403, "verification_required", "verified session required");
  const exp = nowSec() + 24 * 60 * 60; // 24h
  const token = await signViewerSession(
    {
      artifact_id: artifact.id,
      version_id: artifact.current_version_id,
      email: session.email,
      verified: session.verified,
      view_id: session.view_id,
      exp,
      ...(session.link_id ? { link_id: session.link_id } : {}),
      // Comments written with this token render as "via agent · delegated".
      agent: "delegated",
    },
    env,
  );
  const prompt = [
    `You have temporary access to a published artifact. Explore it via its API (no browser needed), read the comment threads, leave any issues as comments, and resolve threads you have addressed.`,
    ``,
    `Artifact: "${artifact.title}" — ${base}`,
    `Auth header for every call:  Authorization: Bearer ${token}   (read+comment, this artifact only, expires ${new Date(exp * 1000).toISOString()})`,
    ``,
    `1. GET  ${base}_au/index.json   -> title, pages, files, entrypoint, content-types`,
    `2. GET  ${base}<file>           -> any page/asset (HTML is fine to read directly)`,
    `3. GET  ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open   -> read the comment threads`,
    `4. POST ${site}/_au/comments  {artifact_key:"${artifact.url_key}", body, parent_id?, target?}   -> comment or reply; returns the comment id`,
    `5. PATCH ${site}/_au/comments  {artifact_key:"${artifact.url_key}", id, resolved:true}   -> resolve a thread once addressed`,
    ``,
    `Recurring/richer access -> connect the MCP at ${site}/mcp, or publish your own there (sign in once).`,
  ].join("\n");
  return json({
    token,
    token_type: "Bearer",
    expires_at: exp,
    share_url: `${base}?agent=${encodeURIComponent(token)}`,
    prompt,
  });
}

export function injectWidget(
  html: string,
  artifact: Artifact,
  versionId: string,
  env: Env,
): string {
  const config = JSON.stringify({
    artifactKey: artifact.url_key,
    versionId,
    gateLevel: artifact.gate_level,
    abuseUrl: abuseMailto(env, {
      artifactKey: artifact.url_key,
      artifactUrl: publicArtifactUrl(env, artifact.url_key),
    }),
  });
  const widget = FEEDBACK_WIDGET_JS.replace(/<\/(script)/gi, "<\\/$1");
  const script = `<script>window.__AU_FEEDBACK__=${config};</script><script>${widget}</script>`;
  // Use a function replacement so `$` sequences in the minified widget (e.g. a
  // variable minified to `$`, giving `$&`) are NOT interpreted as String.replace
  // special patterns — which would otherwise corrupt the script.
  if (html.includes("</body>"))
    return html.replace("</body>", () => `${script}</body>`);
  return `${html}${script}`;
}
