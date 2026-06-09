import type { Env } from "./types";

export const GATE_LEVELS = new Set([
  "public",
  "email",
  "verified_email",
  "allowlist",
]);

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...(init.headers || {}),
    },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

export function readLimit(env: Env, key: "package" | "file" | "count"): number {
  if (key === "package")
    return Number(env.DEFAULT_PACKAGE_LIMIT_BYTES || "99614720");
  if (key === "file") return Number(env.DEFAULT_FILE_LIMIT_BYTES || "78643200");
  return Number(env.DEFAULT_FILE_COUNT_LIMIT || "200");
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export function randomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = new DataView(bytes.buffer).getUint32(0) % 1000000;
  return String(n).padStart(6, "0");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s);
}

export function slugify(value: string, fallback = "publisher"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return isSlug(slug) ? slug : fallback;
}

export function assertSlug(kind: string, s: string): string {
  if (!isSlug(s))
    throw new Error(`${kind} must be lower-case hyphen-case, 1-63 chars`);
  return s;
}

export function validateAssetPath(path: string): string {
  let decoded = decodeURIComponent(path)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  while (decoded.includes("//")) decoded = decoded.replaceAll("//", "/");
  if (!decoded || decoded.length > 512)
    throw new Error("path must be 1-512 chars");
  if (
    decoded.startsWith("_") ||
    decoded.startsWith("_iof/") ||
    decoded.startsWith("_au/")
  ) {
    throw new Error("reserved artifact path");
  }
  if (decoded === "cdn-cgi" || decoded.startsWith("cdn-cgi/"))
    throw new Error("reserved artifact path");
  const parts = decoded.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..")
      throw new Error("invalid path segment");
    if (/[\x00-\x1f\x7f]/.test(part))
      throw new Error("control characters are not allowed in paths");
  }
  return decoded;
}

export function mimeFor(
  path: string,
  fallback = "application/octet-stream",
): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const table: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    woff: "font/woff",
    woff2: "font/woff2",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return table[ext] || fallback;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f6f8f8;color:#1b2429;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:620px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #d9e1e4;border-radius:8px}
label{display:block;margin:16px 0 6px;font-weight:600}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bcc9ce;border-radius:6px;font:inherit}
button{margin-top:18px;padding:11px 14px;border:0;border-radius:6px;background:#126b6f;color:#fff;font-weight:700;cursor:pointer}
.muted{color:#617178}.error{color:#9e2f2f}.row{display:flex;gap:10px;align-items:center}.row input{flex:1}
</style></head><body><main>${body}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] || c;
  });
}
