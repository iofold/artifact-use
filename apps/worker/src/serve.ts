import type { Artifact, ArtifactVersion, Env, PublishManifest } from "./types";
import { getCreator, requirePermission, signViewerSession } from "./auth";
import {
  type CommentAuthor,
  createComment,
  listComments,
  positiveInteger,
  reanchorComment,
  resolveComment,
} from "./comments";
import {
  getArtifactByLegacyPath,
  getArtifactByUrlKey,
  getFile,
  getVersion,
} from "./db";
import { getViewerSession, renderGate } from "./gate";
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
      const url = new URL(request.url);
      url.pathname = publicArtifactPath(env, artifact.url_key) + rest.join("/");
      return Response.redirect(url.toString(), 301);
    }
  }
  if (!artifact || !artifact.current_version_id)
    return error(404, "artifact_not_found", "artifact not found");
  if (
    (rest.length === 1 && rest[0] === artifact.slug) ||
    (rest.length === 0 && !path.endsWith("/"))
  ) {
    const url = new URL(request.url);
    url.pathname = publicArtifactPath(env, artifact.url_key);
    return Response.redirect(url.toString(), 301);
  }
  const url = new URL(request.url);
  const share = await sharePrefill(env, artifact, url.searchParams.get("v"));
  if (artifact.gate_level !== "public") {
    const session = await getViewerSession(request, env, artifact);
    if (
      !session ||
      (requiresVerified(artifact.gate_level) && !session.verified)
    ) {
      // Machine-readable gate: a non-browser fetch gets a 401 + JSON describing
      // how to get in, instead of a 200 HTML email form.
      if (!wantsHtml(request)) return gateJson(env, artifact);
      const gate = renderGate(
        artifact,
        path,
        share.email || "",
        share.id || "",
      );
      if (request.method === "HEAD") {
        return new Response(null, {
          status: gate.status,
          statusText: gate.statusText,
          headers: gate.headers,
        });
      }
      return gate;
    }
  }
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
  assetPath = validateAssetPath(assetPath);
  const row = await getFile(env, version.id, assetPath);
  if (!row) return error(404, "file_not_found", "file not found");
  const rowType = row.content_type || mimeFor(row.path);
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
  const headers = objectHeaders(obj, contentType, artifact.gate_level, isHtml);
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
    const html = await bodyObj.text();
    // Only inject the feedback widget for real browsers; agents get clean HTML.
    const body = wantsHtml(request)
      ? injectWidget(html, artifact, version.id)
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

function objectHeaders(
  obj: R2Object,
  contentType: string,
  gateLevel: Artifact["gate_level"],
  isHtml: boolean,
): Headers {
  const headers = new Headers(COMMON_HEADERS);
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", cacheControl(gateLevel, isHtml));
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  if (!isHtml) {
    headers.set("ETag", obj.httpEtag);
    headers.set("Accept-Ranges", "bytes");
  }
  return headers;
}

function cacheControl(
  gateLevel: Artifact["gate_level"],
  isHtml: boolean,
): string {
  if (isHtml || gateLevel !== "public") return "private, no-store";
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
    const author = await commentIdentity(request, env, artifact, "read");
    // Public artifacts allow open reading; gated ones still require a viewer
    // session or a workspace credential.
    if (!author && artifact.gate_level !== "public")
      return commentsUnauthorized(env, artifact, "read");
    return json(
      await listComments(env, artifact, {
        status: url.searchParams.get("status"),
        since: Number(url.searchParams.get("since")) || null,
        pagePath: url.searchParams.get("page_path"),
        limit: Number(url.searchParams.get("limit")) || null,
      }),
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
    };
    const artifact = await getArtifactByUrlKey(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const author = await commentIdentity(request, env, artifact, "write");
    if (!author) return commentsUnauthorized(env, artifact, "write");
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
    };
    const artifact = await getArtifactByUrlKey(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const author = await commentIdentity(request, env, artifact, "write");
    if (!author) return commentsUnauthorized(env, artifact, "write");
    const id = positiveInteger(body.id);
    if (!id) return error(400, "invalid_comment", "comment id is required");
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
async function commentIdentity(
  request: Request,
  env: Env,
  artifact: Artifact,
  mode: "read" | "write",
): Promise<CommentAuthor | null> {
  const session = await getViewerSession(request, env, artifact);
  if (session) return { email: session.email, viewId: session.view_id };
  if (!bearerToken(request)) return null;
  try {
    const creator = await getCreator(request, env);
    if (!creator || creator.orgId !== artifact.org_id) return null;
    requirePermission(
      creator,
      env,
      mode === "read" ? "artifacts:read" : "artifacts:publish",
    );
    return { email: creator.email || creator.sub, viewId: null };
  } catch {
    return null;
  }
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
          ? "or ask the human who shared this to use 'Hand to your agent' in the feedback widget for a scoped token"
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

async function sharePrefill(
  env: Env,
  artifact: Artifact,
  token: string | null,
): Promise<{ id: string | null; email: string | null }> {
  if (!token) return { id: null, email: null };
  const row = await env.DB.prepare(
    "SELECT id, recipient_email, expires_at, revoked_at FROM share_links WHERE id = ? AND artifact_id = ?",
  )
    .bind(token, artifact.id)
    .first<{
      id: string;
      recipient_email: string | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < nowSec()))
    return { id: null, email: null };
  return { id: row.id, email: row.recipient_email };
}

// M2 — machine-readable gate for non-browser fetches.
function gateJson(env: Env, artifact: Artifact): Response {
  const base = publicArtifactUrl(env, artifact.url_key);
  const site = siteBaseUrl(env);
  const isEmail = artifact.gate_level === "email";
  const needsOtp = requiresVerified(artifact.gate_level);
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
        email_self_serve: isEmail
          ? `POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/email with header 'Accept: application/json' to receive a token`
          : null,
        otp_self_serve: needsOtp
          ? `if you can read the inbox: POST form {artifact_key:"${artifact.url_key}", email} to ${site}/_au/gate/start (the email must be allowlisted for allowlist gates), read the one-time code from that email, then POST form {artifact_key, email, code} to ${site}/_au/gate/verify with header 'Accept: application/json' to receive a token`
          : null,
        delegated: needsOtp
          ? "or ask the human who shared this to use 'Hand to your agent' in the feedback widget for a scoped token"
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
      list: `GET ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open|resolved|all&since=<unix>&page_path=<path> -> threaded comments (parent_comment_id links replies to roots)`,
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
        `3. GET  ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open   -> read the feedback threads`,
        `4. POST ${site}/_au/comments  {artifact_key:"${artifact.url_key}", body, parent_id?, target?}   -> comment or reply; returns the comment id (you'll be asked for an email once)`,
        `5. PATCH ${site}/_au/comments  {artifact_key:"${artifact.url_key}", id, resolved:true}   -> resolve a thread once addressed`,
        ``,
        `Publish your own at ${site}/mcp (sign in once).`,
      ].join("\n"),
    });
  }
  const session = await getViewerSession(request, env, artifact);
  if (!session) return error(401, "unauthorized", "viewer session required");
  if (requiresVerified(artifact.gate_level) && !session.verified)
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
    },
    env,
  );
  const prompt = [
    `You have temporary access to a published artifact. Explore it via its API (no browser needed), read the feedback discussion, leave any issues as comments, and resolve threads you have addressed.`,
    ``,
    `Artifact: "${artifact.title}" — ${base}`,
    `Auth header for every call:  Authorization: Bearer ${token}   (read+comment, this artifact only, expires ${new Date(exp * 1000).toISOString()})`,
    ``,
    `1. GET  ${base}_au/index.json   -> title, pages, files, entrypoint, content-types`,
    `2. GET  ${base}<file>           -> any page/asset (HTML is fine to read directly)`,
    `3. GET  ${site}/_au/comments?artifact_key=${artifact.url_key}&status=open   -> read the feedback threads`,
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

function injectWidget(
  html: string,
  artifact: Artifact,
  versionId: string,
): string {
  const config = JSON.stringify({
    artifactKey: artifact.url_key,
    versionId,
    gateLevel: artifact.gate_level,
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
