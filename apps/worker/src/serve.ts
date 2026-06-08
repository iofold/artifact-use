import type { Artifact, ArtifactFile, ArtifactVersion, Env } from "./types";
import { getArtifactByPath, getFile, getVersion } from "./db";
import { getViewerSession, renderGate } from "./gate";
import {
  error,
  escapeHtml,
  htmlPage,
  json,
  mimeFor,
  nowSec,
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
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return landing(env);
  const [tenant, slug, ...rest] = parts;
  if (!tenant || !slug) return error(404, "not_found", "not found");
  if (!path.endsWith("/") && rest.length === 0) {
    const url = new URL(request.url);
    url.pathname = `/${tenant}/${slug}/`;
    return Response.redirect(url.toString(), 301);
  }
  const artifact = await getArtifactByPath(env, tenant, slug);
  if (!artifact || !artifact.current_version_id)
    return error(404, "artifact_not_found", "artifact not found");
  const url = new URL(request.url);
  const share = await sharePrefill(env, artifact, url.searchParams.get("v"));
  if (artifact.gate_level !== "public") {
    const session = await getViewerSession(request, env, artifact);
    const verifiedRequired =
      artifact.gate_level === "verified_email" ||
      artifact.gate_level === "allowlist";
    if (!session || (verifiedRequired && !session.verified)) {
      return renderGate(artifact, path, share.email || "", share.id || "");
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
  const etag = request.headers.get("If-None-Match");
  const obj = etag
    ? await env.BUCKET.get(row.storage_key, {
        onlyIf: { etagDoesNotMatch: etag },
      })
    : await env.BUCKET.get(row.storage_key);
  if (!obj) {
    const head = await env.BUCKET.head(row.storage_key);
    if (head && request.headers.get("If-None-Match") === head.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: { ...COMMON_HEADERS, ETag: head.httpEtag },
      });
    }
    return error(404, "object_not_found", "object not found");
  }
  if (!("body" in obj)) {
    return new Response(null, {
      status: 304,
      headers: { ...COMMON_HEADERS, ETag: obj.httpEtag },
    });
  }
  const bodyObj = obj as R2ObjectBody;
  const contentType =
    row.content_type || bodyObj.httpMetadata?.contentType || mimeFor(row.path);
  const headers = {
    ...COMMON_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": contentType.startsWith("text/html")
      ? "private, no-store"
      : "public, max-age=300, must-revalidate",
    ETag: obj.httpEtag,
  };
  if (contentType.startsWith("text/html")) {
    const html = await bodyObj.text();
    return new Response(injectWidget(html, artifact), { headers });
  }
  return new Response(bodyObj.body, { headers });
}

export async function handleComments(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if (path === "/_au/comments" && request.method === "GET") {
    const url = new URL(request.url);
    const artifact = await getArtifactByPath(
      env,
      url.searchParams.get("tenant") || "",
      url.searchParams.get("artifact") || "",
    );
    if (!artifact)
      return error(404, "artifact_not_found", "artifact not found");
    const rows = await env.DB.prepare(
      "SELECT id, email, body, created_at FROM comments WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50",
    )
      .bind(artifact.id)
      .all();
    return json({ comments: rows.results || [] });
  }
  if (path === "/_au/comments" && request.method === "POST") {
    const body = (await request.json()) as {
      tenant?: string;
      artifact?: string;
      body?: string;
    };
    const artifact = await getArtifactByPath(
      env,
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
    await env.DB.prepare(
      "INSERT INTO comments (artifact_id, view_id, email, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(artifact.id, session.view_id, session.email, text, nowSec())
      .run();
    return json({ ok: true });
  }
  return error(404, "not_found", "comments route not found");
}

function landing(env: Env): Response {
  return htmlPage(
    "Artifact Use",
    `<h1>Artifact Use</h1>
<p class="muted">Multi-tenant artifact publishing for agents and teams.</p>
<p>Use the API, CLI, or MCP server to publish static artifacts.</p>
<p><code>${escapeHtml(env.SITE_BASE_URL)}/tenant/artifact/</code></p>`,
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
  const script = `<script>
(function(){
  if (window.__artifactUseWidget) return; window.__artifactUseWidget = true;
  var btn=document.createElement('button'); btn.textContent='Comment'; btn.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 12px;border:0;border-radius:6px;background:#12383b;color:#fff;font:600 13px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.18)';
  var panel=document.createElement('div'); panel.style.cssText='display:none;position:fixed;right:18px;bottom:62px;z-index:2147483647;width:min(360px,calc(100vw - 36px));background:#fff;border:1px solid #ccd6da;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.18);font:14px system-ui;color:#1b2429';
  panel.innerHTML='<div style="padding:12px 14px;border-bottom:1px solid #e3e8ea;font-weight:700">Artifact comments</div><div data-au-list style="max-height:220px;overflow:auto;padding:10px 14px"></div><div style="padding:12px 14px;border-top:1px solid #e3e8ea"><textarea data-au-body rows="3" style="box-sizing:border-box;width:100%;resize:vertical"></textarea><button data-au-send style="margin-top:8px;padding:8px 10px;border:0;border-radius:5px;background:#126b6f;color:#fff;font-weight:700">Send</button></div>';
  async function load(){try{var r=await fetch('/_au/comments?tenant=${artifact.tenant_slug}&artifact=${artifact.slug}');var j=await r.json();panel.querySelector('[data-au-list]').innerHTML=(j.comments||[]).map(function(c){return '<p style="margin:0 0 10px"><strong>'+escapeHtml(c.email)+'</strong><br>'+escapeHtml(c.body)+'</p>'}).join('')||'<p style="color:#617178">No comments yet.</p>';}catch(e){}}
  function escapeHtml(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  btn.onclick=function(){panel.style.display=panel.style.display==='none'?'block':'none'; if(panel.style.display==='block') load();};
  panel.querySelector('[data-au-send]').onclick=async function(){var t=panel.querySelector('[data-au-body]');var body=t.value.trim();if(!body)return;await fetch('/_au/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant:'${artifact.tenant_slug}',artifact:'${artifact.slug}',body:body})});t.value='';load();};
  document.documentElement.appendChild(panel); document.documentElement.appendChild(btn);
})();</script>`;
  if (html.includes("</body>"))
    return html.replace("</body>", `${script}</body>`);
  return `${html}${script}`;
}
