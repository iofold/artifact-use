import type { Artifact, ArtifactFile, ArtifactVersion, Env } from "./types";
import {
  getArtifactByLegacyPath,
  getArtifactByPath,
  getArtifactByUrlKey,
  getFile,
  getVersion,
} from "./db";
import { getViewerSession, renderGate } from "./gate";
import {
  error,
  escapeHtml,
  htmlPage,
  json,
  mimeFor,
  nowSec,
  publicArtifactPath,
  publicArtifactUrl,
  stripPublicArtifactPrefix,
  validateAssetPath,
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
    artifact =
      (await getArtifactByPath(env, urlKey || "", legacySlug)) ||
      (await getArtifactByLegacyPath(env, urlKey || "", legacySlug));
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
    if (request.method === "HEAD") return new Response(null, { headers });
    const html = await bodyObj.text();
    return new Response(injectWidget(html, artifact), { headers });
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
      url.searchParams.get("tenant") || "",
      url.searchParams.get("artifact") || "",
    );
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const session = await getViewerSession(request, env, artifact);
    if (!session) return error(401, "unauthorized", "viewer session required");
    const rows = await env.DB.prepare(
      `SELECT id, parent_comment_id, email, body, target_json, created_at, resolved_at, resolved_by
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
      tenant?: string;
      artifact?: string;
      body?: string;
      target?: unknown;
      parent_id?: unknown;
    };
    const artifact = await commentArtifact(
      env,
      body.artifact_key || "",
      body.tenant || "",
      body.artifact || "",
    );
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
    await env.DB.prepare(
      `INSERT INTO comments
       (artifact_id, view_id, email, body, target_json, parent_comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        artifact.id,
        session.view_id,
        session.email,
        text,
        targetJson,
        parent?.id || null,
        nowSec(),
      )
      .run();
    return json({ ok: true });
  }
  if (path === "/_au/comments" && request.method === "PATCH") {
    const body = (await request.json()) as {
      artifact_key?: string;
      tenant?: string;
      artifact?: string;
      id?: unknown;
      resolved?: unknown;
    };
    const artifact = await commentArtifact(
      env,
      body.artifact_key || "",
      body.tenant || "",
      body.artifact || "",
    );
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
  legacyTenant: string,
  legacyArtifact: string,
): Promise<Artifact | null> {
  if (artifactKey) return getArtifactByUrlKey(env, artifactKey);
  if (legacyTenant && legacyArtifact)
    return getArtifactByPath(env, legacyTenant, legacyArtifact);
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

function commentTargetJson(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const input = target as Record<string, unknown>;
  const rect = input.rect as Record<string, unknown> | undefined;
  const clean = {
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
  return JSON.stringify(clean).slice(0, 1200);
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

function injectWidget(html: string, artifact: Artifact): string {
  if (artifact.gate_level === "public") return html;
  const key = JSON.stringify(artifact.url_key);
  const script = `<script>
(function(){
  if (window.__artifactUseWidget) return; window.__artifactUseWidget = true;
  var artifactKey=${key}, target=null, active=null, selecting=false;
  var btn=el('button','au-launch','Feedback'), panel=el('aside','au-panel',''), mark=el('div','au-mark',''), hover=el('div','au-hover','');
  var css=document.createElement('style'); css.textContent='[data-au-widget]{font:13px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201d;letter-spacing:0}[data-au-widget] button{font:inherit}.au-launch{position:fixed;right:18px;bottom:18px;z-index:2147483647;border:0;border-radius:6px;background:#12383b;color:#fff;padding:10px 12px;font-weight:750;box-shadow:0 10px 30px rgba(0,0,0,.2);cursor:pointer}.au-panel{display:none;position:fixed;right:18px;top:18px;z-index:2147483647;width:min(420px,calc(100vw - 36px));max-height:calc(100vh - 36px);background:#fff;border:1px solid #cdd7d4;border-radius:8px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden}.au-head{height:46px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8e6;padding:0 12px;font-weight:800}.au-tools{display:flex;gap:6px}.au-icon{border:0;background:#eef4f2;color:#24312d;border-radius:5px;min-width:30px;height:30px;cursor:pointer}.au-body{padding:12px;display:grid;gap:10px}.au-list{max-height:38vh;overflow:auto;border:1px solid #edf1f0;border-radius:6px}.au-empty{padding:12px}.au-item{border-bottom:1px solid #edf1f0;background:#fff}.au-item:last-child{border-bottom:0}.au-item.is-resolved{background:#fbfcfb}.au-comment{display:grid;gap:7px;padding:10px}.au-reply{display:grid;gap:4px}.au-comment-main{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:0;cursor:pointer}.au-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:1.3;color:#687873}.au-email{font-weight:800;color:#24312d}.au-state{font-weight:800;color:#126b6f}.au-target-label{color:#52625d}.au-textline{white-space:pre-wrap;line-height:1.38;color:#17201d}.au-item.is-resolved .au-textline{color:#61716c}.au-comment-actions,.au-reply-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.au-link{border:0;background:transparent;color:#126b6f;font-weight:800;padding:2px 0;cursor:pointer}.au-replies{display:grid;gap:8px;margin:0 10px 10px;padding-left:10px;border-left:2px solid #dfe8e5}.au-replybox{display:none;margin:0 10px 10px;gap:7px}.au-replybox.is-open{display:grid}.au-target{border:1px solid #dbe4e1;background:#f8fbfa;border-radius:6px;padding:9px;color:#31403b}.au-target strong{display:block;font-size:12px;color:#52625d;margin-bottom:3px}.au-actions{display:flex;gap:8px}.au-action{border:1px solid #becbc7;background:#fff;border-radius:5px;padding:8px 10px;cursor:pointer}.au-send{border:0;background:#126b6f;color:#fff;border-radius:5px;padding:9px 11px;font-weight:800;cursor:pointer}.au-text{width:100%;box-sizing:border-box;border:1px solid #c9d5d1;border-radius:6px;padding:9px 10px;resize:vertical;min-height:76px;font:inherit}.au-smalltext{min-height:54px}.au-muted{color:#687873}.au-mark,.au-hover{position:fixed;display:none;pointer-events:none;z-index:2147483646;border:2px solid #f3a712;border-radius:6px;box-shadow:0 0 0 9999px rgba(18,56,59,.04)}.au-hover{border-color:#126b6f;background:rgba(18,107,111,.08)}';
  panel.dataset.auWidget=btn.dataset.auWidget=mark.dataset.auWidget=hover.dataset.auWidget='1';
  panel.innerHTML='<div class="au-head"><span>Feedback</span><div class="au-tools"><button class="au-icon" data-close title="Minimize" aria-label="Minimize feedback">-</button><button class="au-icon" data-hide title="Close" aria-label="Close feedback">x</button></div></div><div class="au-body"><div class="au-actions"><button class="au-action" data-select>Select element</button><button class="au-action" data-clear>Clear target</button></div><div class="au-target" data-target></div><textarea class="au-text" data-body placeholder="Leave feedback"></textarea><button class="au-send" data-send>Send feedback</button><div class="au-list" data-list></div></div>';
  function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
  function insideWidget(n){return n&&n.closest&&n.closest('[data-au-widget]')}
  function cssEsc(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,function(c){return '\\\\'+c})}
  function selectorFor(e){if(e.id&&document.querySelectorAll('#'+cssEsc(e.id)).length===1)return '#'+cssEsc(e.id);var a=[];for(;e&&e.nodeType===1&&e!==document.body;e=e.parentElement){var n=e.localName,i=1,p=e;while((p=p.previousElementSibling))if(p.localName===n)i++;a.unshift(n+':nth-of-type('+i+')')}return a.length?'body>'+a.join('>'):'body'}
  function labelFor(e){return (e.getAttribute('aria-label')||e.alt||e.title||e.textContent||e.localName||'element').trim().replace(/\\s+/g,' ').slice(0,120)}
  function targetFrom(e){var r=e.getBoundingClientRect();return {selector:selectorFor(e),label:labelFor(e),path:location.pathname,rect:{x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),w:Math.round(r.width),h:Math.round(r.height)}}}
  function find(t){try{return t&&t.selector?document.querySelector(t.selector):null}catch(e){return null}}
  function setBox(box,e){var r=e.getBoundingClientRect(),v=r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;if(!v){box.style.display='none';return}box.style.display='block';box.style.left=Math.max(0,r.left)+'px';box.style.top=Math.max(0,r.top)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px'}
  function update(){var e=find(active||target);if(e)setBox(mark,e);else mark.style.display='none'}
  function renderTarget(){var box=panel.querySelector('[data-target]');box.innerHTML='';box.appendChild(el('strong','', 'Target'));box.appendChild(el('span',target?'':'au-muted',target?target.label:'No element selected'));update()}
  function showMessage(text){var list=panel.querySelector('[data-list]');list.innerHTML='';list.appendChild(el('div','au-empty au-muted',text))}
  async function load(){try{var r=await fetch('/_au/comments?artifact_key='+encodeURIComponent(artifactKey));if(r.status===401){showMessage('Open through the access prompt to view feedback.');return}if(!r.ok){showMessage('Could not load feedback.');return}var j=await r.json();renderList(j.comments||[])}catch(e){showMessage('Could not load feedback.')}}
  function renderList(items){var list=panel.querySelector('[data-list]');list.innerHTML='';var roots=[],replies={};items.forEach(function(c){if(c.parent_comment_id){var k=String(c.parent_comment_id);(replies[k]||(replies[k]=[])).push(c)}else roots.push(c)});roots.sort(function(a,b){return Number(b.created_at||b.id)-Number(a.created_at||a.id)});if(!roots.length){showMessage('No feedback yet.');return}roots.forEach(function(c){var item=el('div','au-item'+(c.resolved_at?' is-resolved':''));item.appendChild(commentNode(c,false));item.appendChild(replyBox(c));var rs=replies[String(c.id)]||[];if(rs.length){var wrap=el('div','au-replies');rs.sort(function(a,b){return Number(a.created_at||a.id)-Number(b.created_at||b.id)}).forEach(function(r){wrap.appendChild(commentNode(r,true))});item.appendChild(wrap)}list.appendChild(item)})}
  function commentNode(c,isReply){var wrap=el('div',isReply?'au-reply':'au-comment'),main=el('button','au-comment-main'),meta=el('div','au-meta'),body=el('div','au-textline',c.body||''),t=parse(c.target_json);main.type='button';meta.appendChild(el('span','au-email',c.email||'Unknown viewer'));if(t&&t.label){meta.appendChild(el('span','au-muted','/'));meta.appendChild(el('span','au-target-label',t.label))}if(c.resolved_at&&!isReply)meta.appendChild(el('span','au-state','Resolved'));main.appendChild(meta);main.appendChild(body);main.onclick=function(){focusTarget(c)};wrap.appendChild(main);if(!isReply){var actions=el('div','au-comment-actions'),reply=el('button','au-link','Reply'),resolve=el('button','au-link',c.resolved_at?'Reopen':'Resolve');reply.type=resolve.type='button';reply.onclick=function(){toggleReply(c.id)};resolve.onclick=function(){setResolved(c,!c.resolved_at)};actions.appendChild(reply);actions.appendChild(resolve);wrap.appendChild(actions)}return wrap}
  function replyBox(c){var box=el('div','au-replybox');box.setAttribute('data-reply-box',c.id);var t=parse(c.target_json),area=el('textarea','au-text au-smalltext'),actions=el('div','au-reply-actions'),send=el('button','au-send','Send reply'),cancel=el('button','au-link','Cancel');area.placeholder='Reply';send.type=cancel.type='button';send.onclick=async function(){var body=area.value.trim();if(!body)return;if(await postComment({body:body,parent_id:c.id,target:t}))area.value=''};cancel.onclick=function(){box.classList.remove('is-open')};actions.appendChild(send);actions.appendChild(cancel);box.appendChild(area);box.appendChild(actions);return box}
  function focusTarget(c){var t=parse(c&&c.target_json);if(!t)return;active=t;var e=find(t);if(e)e.scrollIntoView({block:'center',behavior:'smooth'});setTimeout(update,250)}
  function toggleReply(id){Array.prototype.forEach.call(panel.querySelectorAll('.au-replybox'),function(box){var open=box.getAttribute('data-reply-box')===String(id)&&!box.classList.contains('is-open');box.classList.toggle('is-open',open);if(open){var t=box.querySelector('textarea');setTimeout(function(){if(t)t.focus()},0)}})}
  async function postComment(extra){var payload={artifact_key:artifactKey};for(var k in extra)payload[k]=extra[k];var r=await fetch('/_au/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!r.ok){showMessage('Could not send feedback.');return false}await load();return true}
  async function setResolved(c,resolved){var r=await fetch('/_au/comments',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({artifact_key:artifactKey,id:c.id,resolved:resolved})});if(!r.ok){showMessage('Could not update feedback.');return}load()}
  function parse(s){try{return s?JSON.parse(s):null}catch(e){return null}}
  function open(){panel.style.display='block';load();update()}
  function close(){panel.style.display='none';mark.style.display='none';hover.style.display='none'}
  function hideAll(){close();btn.remove();panel.remove();mark.remove();hover.remove()}
  function over(e){if(!selecting||insideWidget(e.target))return;setBox(hover,e.target)}
  function pick(e){if(!selecting||insideWidget(e.target))return;e.preventDefault();e.stopPropagation();target=targetFrom(e.target);active=target;selecting=false;document.removeEventListener('mouseover',over,true);document.removeEventListener('click',pick,true);hover.style.display='none';renderTarget()}
  btn.onclick=open;panel.querySelector('[data-close]').onclick=close;panel.querySelector('[data-hide]').onclick=hideAll;panel.querySelector('[data-clear]').onclick=function(){target=null;active=null;renderTarget()};panel.querySelector('[data-select]').onclick=function(){selecting=true;document.addEventListener('mouseover',over,true);document.addEventListener('click',pick,true)};
  panel.querySelector('[data-send]').onclick=async function(){var t=panel.querySelector('[data-body]'),body=t.value.trim();if(!body)return;if(await postComment({body:body,target:target})){t.value='';target=null;active=null;renderTarget()}};
  addEventListener('scroll',update,true);addEventListener('resize',update);document.documentElement.appendChild(css);document.documentElement.appendChild(mark);document.documentElement.appendChild(hover);document.documentElement.appendChild(panel);document.documentElement.appendChild(btn);renderTarget();
})();</script>`;
  if (html.includes("</body>"))
    return html.replace("</body>", `${script}</body>`);
  return `${html}${script}`;
}
