import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Creator, Env, UploadSession, ViewerSession } from "./types";
import { bearerToken, json, nowSec } from "./util";
import { stringClaim, workosApiMaybe } from "./workos";

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrlCache = "";

function getJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache || jwksUrlCache !== env.WORKOS_JWKS_URL) {
    jwksUrlCache = env.WORKOS_JWKS_URL;
    jwksCache = createRemoteJWKSet(new URL(env.WORKOS_JWKS_URL));
  }
  return jwksCache;
}

export async function getCreator(
  request: Request,
  env: Env,
): Promise<Creator | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (env.DEV_AUTH_TOKEN && token === env.DEV_AUTH_TOKEN) {
    const sub = env.DEV_AUTH_USER_ID || "";
    if (!isWorkosUserId(sub)) {
      throw new Error(
        "DEV_AUTH_USER_ID must be set to a WorkOS user id when DEV_AUTH_TOKEN is used",
      );
    }
    const email = env.DEV_AUTH_EMAIL || null;
    return {
      sub,
      orgId:
        env.DEV_AUTH_ORG_ID ||
        (await defaultWorkosOrgForUser(env, sub)) ||
        userScopedOrgId(sub),
      email,
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
  const sub = String(claims.sub || "");
  if (!sub) throw new Error("WorkOS token is missing sub");
  if (!isWorkosUserId(sub))
    throw new Error("WorkOS token subject must be a WorkOS user id");
  const rawOrgId = String(
    claims.org_id || claims.organization_id || claims.orgId || "",
  );
  const email = typeof claims.email === "string" ? claims.email : null;
  const orgId =
    rawOrgId ||
    (await defaultWorkosOrgForUser(env, sub)) ||
    userScopedOrgId(sub);
  const permissions = new Set<string>();
  for (const claimName of ["permissions", "scope", "scp", "roles", "role"]) {
    for (const value of extractStringArray(claims[claimName])) {
      permissions.add(value);
    }
  }
  return { sub, orgId, email, permissions, raw: claims };
}

export function requirePermission(
  creator: Creator,
  env: Env,
  permission: string,
): void {
  if (
    creator.permissions.has(permission) ||
    creator.permissions.has("artifacts:admin")
  )
    return;
  const accepted = configuredScopes(env, permission);
  if (accepted.some((scope) => creator.permissions.has(scope))) {
    return;
  }
  throw new Error(`missing permission: ${permission}`);
}

export function unauthorized(env: Env): Response {
  return authRequired(env, "unauthorized", "Bearer token required");
}

export function authRequired(
  env: Env,
  code: string,
  message: string,
): Response {
  return json(
    { error: { code, message } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": [
          `Bearer error="${code}"`,
          `error_description="${message.replaceAll('"', "'")}"`,
          `resource_metadata="${env.SITE_BASE_URL}/.well-known/oauth-protected-resource"`,
        ].join(", "),
      },
    },
  );
}

export function oauthResource(env: Env): string {
  return env.WORKOS_AUDIENCE || `${env.SITE_BASE_URL}/mcp`;
}

export function supportedScopes(env: Env): string[] {
  return configuredScopes(env, "all");
}

function configuredScopes(env: Env, kind: string): string[] {
  if (kind === "all") {
    return (
      splitList(env.ARTIFACT_USE_AUTH_SCOPES) || [
        "openid",
        "profile",
        "email",
        "offline_access",
        "artifacts:publish",
        "artifacts:read",
        "artifacts:manage_access",
        "artifacts:view_stats",
      ]
    );
  }
  if (kind === "artifacts:read" || kind === "artifacts:view_stats") {
    return (
      splitList(env.ARTIFACT_USE_READ_SCOPES) || [
        "artifacts:read",
        "artifacts:view_stats",
        "artifacts:admin",
      ]
    );
  }
  return (
    splitList(env.ARTIFACT_USE_WRITE_SCOPES) || [
      "artifacts:publish",
      "artifacts:manage_access",
      "artifacts:admin",
    ]
  );
}

function splitList(value?: string): string[] | null {
  if (!value) return null;
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractStringArray(value: unknown): string[] {
  if (typeof value === "string") return splitList(value) || [];
  if (Array.isArray(value))
    return value.flatMap((item) => extractStringArray(item));
  return [];
}

async function defaultWorkosOrgForUser(
  env: Env,
  userId: string,
): Promise<string | null> {
  if (!env.WORKOS_API_KEY || !isWorkosUserId(userId)) return null;
  const organization = await workosApiMaybe(
    env,
    `/organizations/external_id/${encodeURIComponent(`artifact-use:${userId}`)}`,
  );
  return stringClaim(organization?.id);
}

function isWorkosUserId(value: string): boolean {
  return /^user_[A-Za-z0-9]+$/.test(value);
}

export function userScopedOrgId(sub: string): string {
  return `user_${sub.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(s: string): Uint8Array {
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

// Generic HMAC token layer shared by viewer sessions, upload tokens, and
// publisher sessions. Deliberately does NOT check exp or typ — each wrapper
// enforces its own claims, which is the only defense against cross-type token
// confusion since every type is signed with the same SESSION_SECRET.
export async function signPayload(payload: unknown, env: Env): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(env.SESSION_SECRET, encoded)}`;
}

export async function verifyPayload<T>(
  raw: string,
  env: Env,
): Promise<T | null> {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if ((await hmac(env.SESSION_SECRET, payload)) !== sig) return null;
  return JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as T;
}

export async function signViewerSession(
  session: ViewerSession,
  env: Env,
): Promise<string> {
  return signPayload(session, env);
}

export async function verifyViewerSession(
  raw: string,
  env: Env,
): Promise<ViewerSession | null> {
  const decoded = await verifyPayload<ViewerSession>(raw, env);
  if (!decoded || !decoded.exp || decoded.exp < nowSec()) return null;
  return decoded;
}

export async function signUploadToken(
  session: UploadSession,
  env: Env,
): Promise<string> {
  return signPayload(session, env);
}

export async function verifyUploadToken(
  raw: string,
  env: Env,
): Promise<UploadSession | null> {
  const decoded = await verifyPayload<UploadSession>(raw, env);
  if (!decoded || decoded.typ !== "artifact_upload") return null;
  if (!decoded.version_id || !decoded.org_id) return null;
  if (!decoded.exp || decoded.exp < nowSec()) return null;
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
    return authRequired(
      env,
      "invalid_token",
      e instanceof Error ? e.message : "invalid bearer token",
    );
  }
}
