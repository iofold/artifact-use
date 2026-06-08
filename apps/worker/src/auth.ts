import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Creator, Env, ViewerSession } from "./types";
import { error, json } from "./util";

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrlCache = "";

function getJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache || jwksUrlCache !== env.WORKOS_JWKS_URL) {
    jwksUrlCache = env.WORKOS_JWKS_URL;
    jwksCache = createRemoteJWKSet(new URL(env.WORKOS_JWKS_URL));
  }
  return jwksCache;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export async function getCreator(
  request: Request,
  env: Env,
): Promise<Creator | null> {
  const token = bearer(request);
  if (!token) return null;
  if (env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    return {
      sub: "dev-user",
      orgId: "org_dev",
      email: "dev@example.com",
      permissions: new Set([
        "artifacts:publish",
        "artifacts:read",
        "artifacts:manage_access",
        "artifacts:view_stats",
        "artifacts:admin",
      ]),
      raw: { dev: true },
    };
  }
  const verified = await jwtVerify(token, getJwks(env), {
    issuer: env.WORKOS_ISSUER,
    audience: env.WORKOS_AUDIENCE,
  });
  const claims = verified.payload as Record<string, unknown>;
  const orgId = String(
    claims.org_id || claims.organization_id || claims.orgId || "",
  );
  const sub = String(claims.sub || "");
  if (!orgId || !sub) throw new Error("WorkOS token is missing org_id or sub");
  const permissionsRaw = claims.permissions;
  const permissions = new Set<string>();
  if (Array.isArray(permissionsRaw))
    for (const p of permissionsRaw) permissions.add(String(p));
  const email = typeof claims.email === "string" ? claims.email : null;
  return { sub, orgId, email, permissions, raw: claims };
}

export function requirePermission(creator: Creator, permission: string): void {
  if (
    creator.permissions.has(permission) ||
    creator.permissions.has("artifacts:admin")
  )
    return;
  throw new Error(`missing permission: ${permission}`);
}

export function unauthorized(env: Env): Response {
  return json(
    { error: { code: "unauthorized", message: "Bearer token required" } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${env.SITE_BASE_URL}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return base64Url(new Uint8Array(sig));
}

export async function signViewerSession(
  session: ViewerSession,
  env: Env,
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

export async function verifyViewerSession(
  raw: string,
  env: Env,
): Promise<ViewerSession | null> {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (expected !== sig) return null;
  const decoded = JSON.parse(
    new TextDecoder().decode(fromBase64Url(payload)),
  ) as ViewerSession;
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function viewerCookieName(artifactId: string): string {
  return `au_${artifactId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

export function setViewerCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; Secure; HttpOnly; SameSite=Lax`;
}

export async function safeCreator(
  request: Request,
  env: Env,
): Promise<Creator | Response> {
  try {
    const creator = await getCreator(request, env);
    return creator || unauthorized(env);
  } catch (e) {
    return error(
      401,
      "invalid_token",
      e instanceof Error ? e.message : "invalid bearer token",
    );
  }
}
