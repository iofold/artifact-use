import { getArtifactByUrlKey, getFile, getVersion } from "./db";
import { unavailableArtifactResponse } from "./moderation";
import type { Artifact, Env } from "./types";
import { escapeHtml, publicArtifactUrl, siteBaseUrl } from "./util";

const PREVIEW_WIDTH = 1200;
const PREVIEW_HEIGHT = 630;
const MAX_DESCRIPTION_LENGTH = 200;

export const ARTIFACT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#132420"/><path d="M18 10h20l10 10v34H18z" fill="#fffdf7"/><path d="M38 10v12h12" fill="#d8ff4a"/><path d="M38 10l12 12H38z" fill="#0b5d52"/><path d="M25 32h16M25 39h16M25 46h10" fill="none" stroke="#0b5d52" stroke-width="3" stroke-linecap="round"/></svg>`;

export function normalizeArtifactDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = decodeHtmlEntities(stripTags(value))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length <= MAX_DESCRIPTION_LENGTH) return normalized;
  const candidate = normalized.slice(0, MAX_DESCRIPTION_LENGTH - 1);
  const boundary = candidate.lastIndexOf(" ");
  const clipped = boundary >= 120 ? candidate.slice(0, boundary) : candidate;
  return `${clipped.trimEnd()}…`;
}

export function extractArtifactDescription(html: string): string | null {
  const metadata = Array.from(html.matchAll(/<meta\b[^>]*>/gi)).map(([tag]) =>
    metaAttributes(tag),
  );
  for (const key of ["og:description", "description"]) {
    for (const attrs of metadata) {
      const identity = (attrs.property || attrs.name || "").toLowerCase();
      if (identity !== key || !attrs.content) continue;
      const description = normalizeArtifactDescription(attrs.content);
      if (description) return description;
    }
  }
  const withoutNoise = html
    .replace(/<(script|style|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  for (const match of withoutNoise.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const description = normalizeArtifactDescription(match[1] || "");
    if (description) return description;
  }
  return null;
}

export function artifactPreviewImageUrl(env: Env, artifact: Artifact): string {
  const revision = previewRevision(artifact);
  return `${siteBaseUrl(env)}/_au/preview/${encodeURIComponent(artifact.url_key)}/${encodeURIComponent(revision)}.png`;
}

export function injectArtifactMetadata(
  html: string,
  env: Env,
  artifact: Artifact,
  contentType: string,
): string {
  const metadata = artifactMetadata(env, artifact, contentType);
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${metadata}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(
      /<html\b[^>]*>/i,
      (root) => `${root}<head>${metadata}</head>`,
    );
  }
  return `<!doctype html><html lang="en"><head>${metadata}</head><body>${html}</body></html>`;
}

export function isLinkPreviewRequest(request: Request): boolean {
  const userAgent = request.headers.get("User-Agent") || "";
  return /(?:Slackbot(?:-LinkExpanding)?|Twitterbot|facebookexternalhit|Facebot|WhatsApp|LinkedInBot|Discordbot|TelegramBot|Pinterestbot|SkypeUriPreview|TeamsBot|MSTeams|MicrosoftPreview|Applebot|Iframely|Embedly|Quora Link Preview)/i.test(
    userAgent,
  );
}

export function renderArtifactPreviewDocument(
  env: Env,
  artifact: Artifact,
  contentType: string,
): Response {
  const description = previewDescription(artifact);
  const type = previewTypeLabel(contentType);
  const access = accessLabel(artifact.gate_level);
  const body = `<!doctype html><html lang="en"><head></head><body><main><p>ARTIFACT USE · ${escapeHtml(type)}</p><h1>${escapeHtml(artifact.title)}</h1><p>${escapeHtml(description)}</p><p>${escapeHtml(access)}</p></main></body></html>`;
  return new Response(
    injectArtifactMetadata(body, env, artifact, contentType),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        Vary: "User-Agent, Accept, Cookie, Authorization",
      },
    },
  );
}

export function renderPreviewCardHtml(
  env: Env,
  artifact: Artifact,
  contentType: string,
): string {
  const title = escapeHtml(artifact.title);
  const description = escapeHtml(previewDescription(artifact));
  const access = escapeHtml(accessLabel(artifact.gate_level));
  const type = escapeHtml(previewTypeLabel(contentType));
  const host = escapeHtml(safeHost(env));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${PREVIEW_WIDTH}px;height:${PREVIEW_HEIGHT}px;overflow:hidden;background:#f6f4ec;color:#132420}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:44px}
.sheet{position:relative;width:100%;height:100%;overflow:hidden;border:2px solid #132420;background:#fffdf7;box-shadow:14px 14px 0 #0b5d52;padding:39px 45px 35px 46px;display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:50px}
.sheet:before{content:"";position:absolute;inset:12px;border:1px solid #ddd7c6;pointer-events:none}
.copy{position:relative;z-index:1;min-width:0;display:flex;flex-direction:column}
.eyebrow{display:flex;align-items:center;gap:13px;font:800 19px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;color:#0b5d52}
.register{width:15px;height:15px;border-radius:50%;background:#d8ff4a;border:2px solid #132420;box-shadow:4px 0 0 #0b5d52}
h1{margin:50px 0 21px;max-width:760px;font-family:Iowan Old Style,Palatino Linotype,Book Antiqua,Georgia,serif;font-size:66px;line-height:.98;letter-spacing:-.047em;font-weight:700;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.summary{margin:0;max-width:735px;color:#4e5d56;font-size:25px;line-height:1.32;letter-spacing:-.015em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ledger{margin-top:auto;padding-top:24px;border-top:2px solid #132420;display:flex;gap:11px;align-items:center;color:#132420;font:750 16px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.045em;text-transform:uppercase}
.pill{border:1.5px solid #132420;padding:9px 12px;background:#f6f4ec}.pill.access{background:#d8ff4a}.slug{margin-left:auto;max-width:370px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#68726c;font-size:14px;text-transform:none;letter-spacing:0}
.mark{position:relative;z-index:1;display:flex;align-items:center;justify-content:center}
.document{position:relative;width:266px;height:356px;background:#f6f4ec;border:3px solid #132420;box-shadow:11px 11px 0 #d8ff4a}
.document:before{content:"";position:absolute;right:-3px;top:-3px;width:85px;height:85px;background:linear-gradient(45deg,#fffdf7 0 48%,#132420 49% 51%,#0b5d52 52%);clip-path:polygon(0 0,100% 100%,0 100%);transform:rotate(180deg)}
.line{position:absolute;left:35px;height:9px;background:#0b5d52}.l1{top:142px;width:170px}.l2{top:177px;width:154px}.l3{top:212px;width:177px}.l4{top:247px;width:110px}
.seal{position:absolute;right:-31px;bottom:35px;width:102px;height:102px;border-radius:50%;background:#d8ff4a;border:3px solid #132420;display:grid;place-items:center;text-align:center;font:900 13px/1.08 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;transform:rotate(-7deg);box-shadow:7px 7px 0 #0b5d52}
.folio{position:absolute;right:24px;bottom:17px;color:#68726c;font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em}
</style></head><body><section class="sheet"><div class="copy"><div class="eyebrow"><span class="register"></span>ARTIFACT USE <span>—</span> PUBLISHED</div><h1>${title}</h1><p class="summary">${description}</p><div class="ledger"><span class="pill access">${access}</span><span class="pill">${type}</span><span class="slug">${host}</span></div></div><div class="mark" aria-hidden="true"><div class="document"><span class="line l1"></span><span class="line l2"></span><span class="line l3"></span><span class="line l4"></span><span class="seal">SHARED<br>ARTIFACT</span><span class="folio">AU / 01</span></div></div></section></body></html>`;
}

export async function handleArtifactPreviewAsset(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if (path === "/_au/artifact-icon.svg") {
    return new Response(
      request.method === "HEAD" ? null : ARTIFACT_FAVICON_SVG,
      {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  const match = path.match(/^\/_au\/preview\/([^/]+)\/([^/]+)\.png$/);
  if (!match) return previewError(404, "preview_not_found");
  if (request.method !== "GET" && request.method !== "HEAD")
    return previewError(405, "method_not_allowed");
  const urlKey = decodeURIComponent(match[1] || "");
  const revision = decodeURIComponent(match[2] || "");
  const artifact = await getArtifactByUrlKey(env, urlKey);
  if (!artifact || !artifact.current_version_id)
    return previewError(404, "preview_not_found");
  const unavailable = unavailableArtifactResponse(request, artifact);
  if (unavailable) return unavailable;
  if (revision !== previewRevision(artifact))
    return previewError(404, "preview_not_found");

  const storageKey = `previews/${artifact.id}/${revision}.png`;
  const cached = await env.BUCKET.get(storageKey);
  if (cached && "body" in cached) {
    return pngResponse(request, cached.body, cached.size, cached.httpEtag);
  }
  if (!env.BROWSER) return previewError(503, "preview_unavailable");

  const version = await getVersion(env, artifact.current_version_id);
  const file = version
    ? await getFile(env, version.id, version.entrypoint || "index.html")
    : null;
  const contentType = file?.content_type || "application/octet-stream";
  const generated = await env.BROWSER.quickAction("screenshot", {
    html: renderPreviewCardHtml(env, artifact, contentType),
    screenshotOptions: {
      type: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    },
    viewport: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
  });
  if (!generated.ok) return previewError(503, "preview_unavailable");
  const bytes = new Uint8Array(await generated.arrayBuffer());
  if (!isPng(bytes)) return previewError(502, "preview_invalid");
  await env.BUCKET.put(storageKey, bytes, {
    httpMetadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return pngResponse(request, bytes, bytes.byteLength);
}

function artifactMetadata(
  env: Env,
  artifact: Artifact,
  contentType: string,
): string {
  const title = escapeHtml(artifact.title);
  const description = escapeHtml(previewDescription(artifact));
  const canonical = escapeHtml(publicArtifactUrl(env, artifact.url_key));
  const image = escapeHtml(artifactPreviewImageUrl(env, artifact));
  const imageAlt = escapeHtml(`${artifact.title} — Artifact Use preview`);
  const type = escapeHtml(previewTypeLabel(contentType));
  return `<meta property="og:type" content="website"><meta property="og:site_name" content="Artifact Use"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}"><meta property="og:image:secure_url" content="${image}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="${PREVIEW_WIDTH}"><meta property="og:image:height" content="${PREVIEW_HEIGHT}"><meta property="og:image:alt" content="${imageAlt}"><meta name="description" content="${description}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${image}"><meta name="twitter:image:alt" content="${imageAlt}"><meta name="artifact-use:type" content="${type}"><link rel="canonical" href="${canonical}"><link rel="icon" type="image/svg+xml" href="${escapeHtml(`${siteBaseUrl(env)}/_au/artifact-icon.svg`)}">`;
}

function previewDescription(artifact: Artifact): string {
  return (
    normalizeArtifactDescription(artifact.description) ||
    `${artifact.title} — a published artifact shared with Artifact Use.`
  );
}

function previewRevision(artifact: Artifact): string {
  const version = (artifact.current_version_id || "unpublished").replace(
    /[^a-zA-Z0-9_-]/g,
    "",
  );
  return `${version}-${Math.max(0, Number(artifact.updated_at) || 0)}`;
}

function previewTypeLabel(contentType: string): string {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (mediaType === "text/html") return "INTERACTIVE";
  if (mediaType === "application/pdf") return "PDF";
  if (mediaType.startsWith("image/")) return "IMAGE";
  if (mediaType.startsWith("video/")) return "VIDEO";
  if (mediaType.startsWith("audio/")) return "AUDIO";
  if (mediaType.startsWith("text/")) return "DOCUMENT";
  return "FILE";
}

function accessLabel(level: Artifact["gate_level"]): string {
  if (level === "public") return "PUBLIC";
  if (level === "email") return "EMAIL ACCESS";
  if (level === "verified_email") return "VERIFIED EMAIL";
  return "ALLOWLIST";
}

function safeHost(env: Env): string {
  try {
    return new URL(siteBaseUrl(env)).host;
  } catch {
    return "artifact.use";
  }
}

function metaAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    const name = (match[1] || "").toLowerCase();
    attributes[name] = decodeHtmlEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string, hex: string, name: string) => {
      if (decimal) return safeCodePoint(Number(decimal), entity);
      if (hex) return safeCodePoint(Number.parseInt(hex, 16), entity);
      return named[name.toLowerCase()] ?? entity;
    },
  );
}

function safeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff)
    return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((byte, index) => bytes[index] === byte);
}

function pngResponse(
  request: Request,
  body: BodyInit,
  size: number,
  etag?: string,
): Response {
  const headers = new Headers({
    "Content-Type": "image/png",
    "Content-Length": String(size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  if (etag) headers.set("ETag", etag);
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

function previewError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
