import type { Artifact, ArtifactVersion, Env, PublishManifest } from "./types";
import { signViewerSession } from "./auth";
import {
  getArtifactByLegacyPath,
  getArtifactByUrlKey,
  getFile,
  getVersion,
} from "./db";
import { getViewerSession, renderGate } from "./gate";
import { FEEDBACK_WIDGET_JS } from "./widget/feedback.generated";
import {
  error,
  escapeHtml,
  htmlPage,
  json,
  mimeFor,
  nowSec,
  publicArtifactPath,
  publicArtifactUrl,
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
  if (rest.length === 1 && rest[0] === artifact.slug) {
    const url = new URL(request.url);
    url.pathname = publicArtifactPath(env, artifact.url_key);
    return Response.redirect(url.toString(), 301);
  }
  if (!path.endsWith("/") && rest.length === 0) {
    const url = new URL(request.url);
    url.pathname = publicArtifactPath(env, artifact.url_key);
    return Response.redirect(url.toString(), 301);
  }
  const url = new URL(request.url);
  const share = await sharePrefill(env, artifact, url.searchParams.get("v"));
  if (artifact.gate_level !== "public") {
    const session = await getViewerSession(request, env, artifact);
    const verifiedRequired =
      artifact.gate_level === "verified_email" ||
      artifact.gate_level === "allowlist";
    if (!session || (verifiedRequired && !session.verified)) {
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
  let assetPath = rest.join("/") || version.entrypoint || "index.html";
  if (assetPath.endsWith("/")) assetPath += "index.html";
  assetPath = validateAssetPath(assetPath);
  const row = await getFile(env, version.id, assetPath);
  if (!row) return error(404, "file_not_found", "file not found");
  const rowType = row.content_type || mimeFor(row.path);
  const isHtmlPath =
    mediaType(rowType) === "text/html" || /\.html?$/i.test(row.path);
  const getOptions: R2GetOptions = {};
  const onlyIf = isHtmlPath ? undefined : conditionalHeaders(request.headers);
  if (onlyIf) getOptions.onlyIf = onlyIf;
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

function conditionalHeaders(headers: Headers): Headers | undefined {
  const conditional = new Headers();
  for (const name of [
    "If-Match",
    "If-None-Match",
    "If-Modified-Since",
    "If-Unmodified-Since",
  ]) {
    const value = headers.get(name);
    if (value) conditional.set(name, value);
  }
  return [...conditional].length ? conditional : undefined;
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
  if (path === "/_au/comments" && request.method === "GET") {
    const url = new URL(request.url);
    const artifact = await commentArtifact(
      env,
      url.searchParams.get("artifact_key") || "",
    );
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const session = await getViewerSession(request, env, artifact);
    // Public artifacts allow open reading; gated ones still require a session.
    if (!session && artifact.gate_level !== "public")
      return error(401, "unauthorized", "viewer session required");
    const rows = await env.DB.prepare(
      `SELECT id, parent_comment_id, email, body, target_json, page_path, version_id, created_at, resolved_at, resolved_by
       FROM comments
       WHERE artifact_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(parent_comment_id, id) DESC,
         CASE WHEN parent_comment_id IS NULL THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 200`,
    )
      .bind(artifact.id)
      .all();
    return json({ comments: rows.results || [] });
  }
  if (path === "/_au/comments" && request.method === "POST") {
    const body = (await request.json()) as {
      artifact_key?: string;
      body?: string;
      target?: unknown;
      parent_id?: unknown;
      page_path?: unknown;
      version_id?: unknown;
    };
    const artifact = await commentArtifact(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const session = await getViewerSession(request, env, artifact);
    if (!session) return error(401, "unauthorized", "viewer session required");
    const text = String(body.body || "")
      .trim()
      .slice(0, 2000);
    if (!text) return error(400, "body_required", "comment body required");
    const parentId = positiveInteger(body.parent_id);
    const parent = parentId
      ? await commentParent(env, artifact.id, parentId)
      : null;
    if (parentId && !parent)
      return error(404, "comment_not_found", "parent comment not found");
    const targetJson =
      commentTargetJson(body.target) || parent?.target_json || null;
    const pagePath =
      cleanStr(body.page_path, 300) || targetPath(targetJson) || null;
    const versionId = cleanStr(body.version_id, 64);
    await env.DB.prepare(
      `INSERT INTO comments
       (artifact_id, view_id, email, body, target_json, page_path, version_id, parent_comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        artifact.id,
        session.view_id,
        session.email,
        text,
        targetJson,
        pagePath,
        versionId,
        parent?.id || null,
        nowSec(),
      )
      .run();
    return json({ ok: true });
  }
  if (path === "/_au/comments" && request.method === "PATCH") {
    const body = (await request.json()) as {
      artifact_key?: string;
      id?: unknown;
      resolved?: unknown;
      target?: unknown;
    };
    const artifact = await commentArtifact(env, body.artifact_key || "");
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const session = await getViewerSession(request, env, artifact);
    if (!session) return error(401, "unauthorized", "viewer session required");
    const id = positiveInteger(body.id);
    if (!id) return error(400, "invalid_comment", "comment id is required");
    const existing = await env.DB.prepare(
      "SELECT id FROM comments WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL",
    )
      .bind(id, artifact.id)
      .first<{ id: number }>();
    if (!existing) return error(404, "comment_not_found", "comment not found");
    // Re-anchor: replace the comment's target with a freshly picked element.
    if (body.target !== undefined) {
      const targetJson = commentTargetJson(body.target);
      if (!targetJson) return error(400, "invalid_target", "target is invalid");
      const pagePath = targetPath(targetJson);
      await env.DB.prepare(
        "UPDATE comments SET target_json = ?, page_path = ? WHERE id = ? AND artifact_id = ?",
      )
        .bind(targetJson, pagePath, id, artifact.id)
        .run();
      return json({ ok: true, comment: { id, target_json: targetJson } });
    }
    const resolved = body.resolved !== false;
    const resolvedAt = resolved ? nowSec() : null;
    const resolvedBy = resolved ? session.email : null;
    await env.DB.prepare(
      "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ? AND artifact_id = ?",
    )
      .bind(resolvedAt, resolvedBy, id, artifact.id)
      .run();
    return json({
      ok: true,
      comment: { id, resolved_at: resolvedAt, resolved_by: resolvedBy },
    });
  }
  return error(404, "not_found", "comments route not found");
}

async function commentArtifact(
  env: Env,
  artifactKey: string,
): Promise<Artifact | null> {
  if (artifactKey) return getArtifactByUrlKey(env, artifactKey);
  return null;
}

async function commentParent(
  env: Env,
  artifactId: string,
  parentId: number,
): Promise<{ id: number; target_json: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT id, parent_comment_id, target_json
     FROM comments
     WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
  )
    .bind(parentId, artifactId)
    .first<{
      id: number;
      parent_comment_id: number | null;
      target_json: string | null;
    }>();
  if (!row) return null;
  if (!row.parent_comment_id)
    return { id: row.id, target_json: row.target_json };
  const root = await env.DB.prepare(
    `SELECT id, target_json
     FROM comments
     WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
  )
    .bind(row.parent_comment_id, artifactId)
    .first<{ id: number; target_json: string | null }>();
  if (!root) return null;
  return { id: root.id, target_json: row.target_json || root.target_json };
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface CleanTarget {
  v: number;
  selector: string;
  label: string;
  path: string;
  version_id?: string;
  text?: string;
  anchors?: { type: string; value: string; name?: string }[];
  rect: { x: number; y: number; w: number; h: number } | null;
}

function commentTargetJson(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const input = target as Record<string, unknown>;
  const rect = input.rect as Record<string, unknown> | undefined;
  const anchorsIn = Array.isArray(input.anchors) ? input.anchors : [];
  const anchors = anchorsIn
    .slice(0, 6)
    .map((a) => {
      const o = (a || {}) as Record<string, unknown>;
      const out: { type: string; value: string; name?: string } = {
        type: String(o.type || "").slice(0, 16),
        value: String(o.value || "").slice(0, 300),
      };
      if (o.name) out.name = String(o.name).slice(0, 160);
      return out;
    })
    .filter((a) => a.type && a.value);
  const clean: CleanTarget = {
    v: 2,
    selector: String(input.selector || "").slice(0, 300),
    label: String(input.label || "").slice(0, 160),
    path: String(input.path || "").slice(0, 300),
    rect: rect
      ? {
          x: finiteNumber(rect.x),
          y: finiteNumber(rect.y),
          w: finiteNumber(rect.w),
          h: finiteNumber(rect.h),
        }
      : null,
  };
  if (input.version_id)
    clean.version_id = String(input.version_id).slice(0, 64);
  if (input.text) clean.text = String(input.text).slice(0, 200);
  if (anchors.length) clean.anchors = anchors;
  return JSON.stringify(clean).slice(0, 2000);
}

function targetPath(targetJson: string | null): string | null {
  if (!targetJson) return null;
  try {
    const p = (JSON.parse(targetJson) as { path?: unknown }).path;
    return p ? String(p).slice(0, 300) : null;
  } catch {
    return null;
  }
}

function cleanStr(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).slice(0, max);
  return s || null;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function landing(env: Env): Response {
  return htmlPage(
    "Artifact Use",
    `<h1>Artifact Use</h1>
<p class="muted">Artifact publishing for agents and teams.</p>
<p>Use the API, CLI, or MCP server to publish static artifacts.</p>
<p><code>${escapeHtml(publicArtifactUrl(env, "example-abc123"))}</code></p>`,
  );
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
        delegated: isEmail
          ? null
          : "ask the human who shared this to use 'Hand to your agent' in the feedback widget for a scoped token",
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
      method: "POST",
      body: {
        artifact_key: artifact.url_key,
        body: "<your comment>",
        page_path: "<location.pathname of the page>",
        target: "<optional>",
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
        `3. POST ${site}/_au/comments  {artifact_key:"${artifact.url_key}", body, page_path, target?}   -> leave feedback (you'll be asked for an email once)`,
        ``,
        `Publish your own at ${site}/mcp (sign in once).`,
      ].join("\n"),
    });
  }
  const session = await getViewerSession(request, env, artifact);
  if (!session) return error(401, "unauthorized", "viewer session required");
  const verifiedRequired =
    artifact.gate_level === "verified_email" ||
    artifact.gate_level === "allowlist";
  if (verifiedRequired && !session.verified)
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
    `You have temporary read access to a published artifact. Explore it via its API (no browser needed), summarize it, and leave any issues as feedback.`,
    ``,
    `Artifact: "${artifact.title}" — ${base}`,
    `Auth header for every call:  Authorization: Bearer ${token}   (read+comment, this artifact only, expires ${new Date(exp * 1000).toISOString()})`,
    ``,
    `1. GET  ${base}_au/index.json   -> title, pages, files, entrypoint, content-types`,
    `2. GET  ${base}<file>           -> any page/asset (HTML is fine to read directly)`,
    `3. POST ${site}/_au/comments  {artifact_key:"${artifact.url_key}", body, page_path, target?}   -> leave feedback`,
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
