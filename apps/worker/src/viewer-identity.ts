// "Continue with Google" on artifact gates, through WorkOS.
//
// A viewer signs in with Google (WorkOS User Management, provider
// GoogleOAuth) instead of waiting for an email code. The email Google
// reports as verified passes the gate exactly as a code would. Viewers stay
// viewers: no WorkOS organization, no publisher session — the publisher
// login (/callback) would create a workspace for every new user.
//
// Coming back from Google passes the gate the viewer started from and lands
// on the page (gate.ts finishGoogleSignIn). Staying signed in: a site-wide
// viewer identity cookie (au_vid) remembers the Google-verified email, so
// other artifacts' gates offer a one-click "Continue as". It never grants
// workspace membership and never passes another artifact's gate by itself:
// that click is the consent.
//
// Every artifact shares this origin and runs untrusted script, which can
// fetch() other pages and even make its own URL look like another artifact's
// (history.pushState) before submitting a form. So:
//   - a signed-in address is rendered only on top-level page loads
//     (topLevelNavigation), which gate pages answer with COOP and
//     X-Frame-Options so no other page can read them;
//   - the "Continue as" form carries a consent token bound to the signed-in
//     cookie and the artifact (gateConsentToken), which a script elsewhere
//     can neither read nor compute.
import { readCookie, signPayload, verifyPayload } from "./auth";
import type { Env } from "./types";
import { normalizeEmail, nowSec } from "./util";

export const VIEWER_IDENTITY_COOKIE = "au_vid";
export const VIEWER_IDENTITY_DAYS = 30;
export const GOOGLE_STATE_COOKIE = "au_gstate";
export const GOOGLE_STATE_SEC = 10 * 60;
export const GOOGLE_START_PATH = "/_au/gate/google/start";
export const GOOGLE_CALLBACK_PATH = "/_au/gate/google/callback";

export interface ViewerIdentity {
  typ: "viewer_identity";
  email: string;
  // WorkOS user id, for membership checks.
  sub: string;
  via: "google";
  exp: number;
}

export interface GoogleGateState {
  typ: "gate_google_state";
  state: string;
  artifact_id: string;
  redirect_to: string;
  share_link_id: string | null;
  exp: number;
}

export function googleGateEnabled(env: Env): boolean {
  return (
    env.GATE_GOOGLE_SIGNIN === "true" &&
    !!env.WORKOS_CLIENT_ID &&
    !!env.WORKOS_API_KEY
  );
}

export function googleCallbackUrl(env: Env): string {
  return `${env.SITE_BASE_URL.replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}`;
}

export function googleAuthorizeUrl(env: Env, state: string): string {
  const url = new URL("https://api.workos.com/user_management/authorize");
  url.searchParams.set("client_id", env.WORKOS_CLIENT_ID || "");
  url.searchParams.set("redirect_uri", googleCallbackUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "GoogleOAuth");
  url.searchParams.set("state", state);
  return url.toString();
}

function cookie(name: string, value: string, maxAge: number, path = "/") {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export async function viewerIdentityCookie(
  env: Env,
  email: string,
  sub: string,
): Promise<string> {
  const maxAge = VIEWER_IDENTITY_DAYS * 86400;
  const identity: ViewerIdentity = {
    typ: "viewer_identity",
    email: normalizeEmail(email),
    sub,
    via: "google",
    exp: nowSec() + maxAge,
  };
  return cookie(
    VIEWER_IDENTITY_COOKIE,
    await signPayload(identity, env),
    maxAge,
  );
}

export function expireViewerIdentityCookie(): string {
  return `${VIEWER_IDENTITY_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export async function readViewerIdentity(
  request: Request,
  env: Env,
): Promise<ViewerIdentity | null> {
  const raw = readCookie(request, VIEWER_IDENTITY_COOKIE);
  if (!raw) return null;
  const identity = await verifyPayload<ViewerIdentity>(raw, env);
  // The typ check keeps viewer sessions and publisher sessions (same secret,
  // same format) from ever reading as an identity, and the other way round.
  if (
    !identity ||
    identity.typ !== "viewer_identity" ||
    !identity.email ||
    !identity.exp ||
    identity.exp < nowSec()
  )
    return null;
  return identity;
}

export async function googleStateCookie(
  env: Env,
  state: Omit<GoogleGateState, "typ" | "exp">,
): Promise<string> {
  const payload: GoogleGateState = {
    typ: "gate_google_state",
    ...state,
    exp: nowSec() + GOOGLE_STATE_SEC,
  };
  return cookie(
    GOOGLE_STATE_COOKIE,
    await signPayload(payload, env),
    GOOGLE_STATE_SEC,
    "/_au/gate/google",
  );
}

export function expireGoogleStateCookie(): string {
  return `${GOOGLE_STATE_COOKIE}=; Path=/_au/gate/google; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export async function readGoogleState(
  request: Request,
  env: Env,
): Promise<GoogleGateState | null> {
  const raw = readCookie(request, GOOGLE_STATE_COOKIE);
  if (!raw) return null;
  const state = await verifyPayload<GoogleGateState>(raw, env);
  if (
    !state ||
    state.typ !== "gate_google_state" ||
    !state.state ||
    !state.artifact_id ||
    !state.exp ||
    state.exp < nowSec()
  )
    return null;
  return state;
}

// A top-level page load, as the browser reports it. Fails closed: a browser
// without Fetch Metadata never sees "Continue as" and uses Google or the
// email form instead.
export function topLevelNavigation(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Mode") === "navigate" &&
    request.headers.get("Sec-Fetch-Dest") === "document"
  );
}

// Long enough for a gate page left open; the token is useless to anyone
// without this browser's signed-in cookie.
export const GATE_CONSENT_SEC = 12 * 60 * 60;

interface GateConsent {
  typ: "gate_consent";
  artifact_id: string;
  // Hash of the signed-in cookie (au_pub or au_vid) the form was shown to.
  b: string;
  exp: number;
}

async function cookieBinding(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`gate-consent:${raw}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function gateConsentToken(
  env: Env,
  artifactId: string,
  signedInRaw: string,
): Promise<string> {
  const consent: GateConsent = {
    typ: "gate_consent",
    artifact_id: artifactId,
    b: await cookieBinding(signedInRaw),
    exp: nowSec() + GATE_CONSENT_SEC,
  };
  return signPayload(consent, env);
}

export async function gateConsentValid(
  env: Env,
  token: string,
  artifactId: string,
  signedInRaw: string,
): Promise<boolean> {
  if (!token || !signedInRaw) return false;
  let consent: GateConsent | null = null;
  try {
    consent = await verifyPayload<GateConsent>(token, env);
  } catch {
    return false;
  }
  return (
    !!consent &&
    consent.typ === "gate_consent" &&
    consent.artifact_id === artifactId &&
    !!consent.exp &&
    consent.exp >= nowSec() &&
    consent.b === (await cookieBinding(signedInRaw))
  );
}

export type GoogleSignInResult =
  | { kind: "verified"; email: string; sub: string }
  // Google (via WorkOS) did not vouch for the address; fall back to a code.
  | { kind: "unverified"; email: string | null }
  | { kind: "failed"; reason: string };

// Exchange the authorization code. A user who belongs to several WorkOS
// organizations gets organization_selection_required with the authenticated
// user attached; for a gate that is still a completed Google sign-in.
export async function authenticateGoogleCode(
  request: Request,
  env: Env,
  code: string,
): Promise<GoogleSignInResult> {
  let res: Response;
  try {
    res = await fetch("https://api.workos.com/user_management/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: env.WORKOS_CLIENT_ID,
        client_secret: env.WORKOS_API_KEY,
        code,
        ip_address: request.headers.get("CF-Connecting-IP") || undefined,
        user_agent: request.headers.get("User-Agent") || undefined,
      }),
    });
  } catch {
    return { kind: "failed", reason: "workos_unreachable" };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { kind: "failed", reason: `workos_${res.status}` };
  }
  let user: Record<string, unknown> | null = null;
  if (res.ok) user = asRecord(body.user);
  else if (body.code === "organization_selection_required")
    user = asRecord(body.user);
  else if (body.code === "email_verification_required")
    return {
      kind: "unverified",
      email: typeof body.email === "string" ? normalizeEmail(body.email) : null,
    };
  if (!user)
    return {
      kind: "failed",
      reason: String(body.code || body.error || `workos_${res.status}`),
    };
  const email =
    typeof user.email === "string" ? normalizeEmail(user.email) : "";
  const sub = typeof user.id === "string" ? user.id : "";
  if (!email || !sub) return { kind: "failed", reason: "missing_identity" };
  if (user.email_verified !== true) return { kind: "unverified", email };
  return { kind: "verified", email, sub };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
