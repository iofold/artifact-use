// Browser origins, rather than paths or Referer, separate untrusted artifacts.
// Published links stay stable on SITE_BASE_URL; interactive documents redirect
// to an artifact-specific host with host-only cookies and storage.
import type { Artifact, Env, ViewerSession } from "./types";
import { getArtifactById } from "./db";
import {
  setViewerCookie,
  signViewerSession,
  verifyViewerSession,
  viewerCookieName,
  readCookie,
  signPayload,
  verifyPayload,
} from "./auth";
import { error, nowSec, publicArtifactPath, randomId, sha256Hex } from "./util";

export function isTrustedOrigin(request: Request, env: Env): boolean {
  return (
    !env.SITE_BASE_URL ||
    new URL(request.url).origin === new URL(env.SITE_BASE_URL).origin
  );
}

// SameSite cookies can accompany sibling-origin form posts. Browser writes
// need their own origin check; Origin-less agent HTTP calls remain supported.
export function checkViewerMutation(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (
    !path.startsWith("/_au/") ||
    ["GET", "HEAD", "OPTIONS"].includes(request.method)
  )
    return null;
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    (!origin && site && site !== "same-origin" && site !== "none")
  )
    return error(
      403,
      "origin_forbidden",
      "continue from this artifact's own page",
    );
  if (
    /^\/_au\/(comments|profile|agent-token)$/.test(path) &&
    !/^application\/json(?:;|$)/i.test(
      request.headers.get("Content-Type") || "",
    )
  )
    return error(415, "json_required", "send an application/json body");
  return null;
}

// Running without isolation is a choice a deployment makes by name, never
// what a missing suffix falls back to. Artifact pages then execute on
// SITE_BASE_URL as they did before per-artifact hosts existed, which leaves
// uploaded scripts same-origin with the admin and with every other artifact:
// a hostile page can act as whoever opens it. The suffix wins when both are
// set.
export function sharedOriginArtifacts(env: Env): boolean {
  return (
    !(env.ARTIFACT_HOST_SUFFIX || "").trim() &&
    (env.ARTIFACT_SHARED_ORIGIN || "").trim().toLowerCase() === "true"
  );
}

export function artifactOrigin(env: Env, artifact: Artifact): string | null {
  const suffix = (env.ARTIFACT_HOST_SUFFIX || "").trim().toLowerCase();
  if (!suffix) return null;
  // Production ids are 128 random bits. Short ids support local fixtures.
  const id = artifact.id.replace(/^art_/, "");
  if (!/^[a-z0-9]{1,40}$/.test(id)) throw new Error("invalid artifact host id");
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(suffix))
    throw new Error("invalid artifact host suffix");
  return `${new URL(env.SITE_BASE_URL).protocol}//a-${id}.${suffix}`;
}

// Runs before routing, including preflights. No admin/auth/API surface is
// available on an artifact host, and its viewer routes can name only itself.
export async function checkRequestOrigin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (isTrustedOrigin(request, env)) return null;
  const url = new URL(request.url);
  const suffix = (env.ARTIFACT_HOST_SUFFIX || "").trim().toLowerCase();
  if (!suffix || !url.host.endsWith(`.${suffix}`))
    return error(404, "not_found", "not found");
  const label = url.host.slice(0, -suffix.length - 1);
  const match = /^a-([a-z0-9]{1,40})$/.exec(label);
  if (!match) return error(404, "not_found", "not found");
  const artifact = await getArtifactById(env, `art_${match[1]}`);
  if (!artifact || artifactOrigin(env, artifact) !== url.origin)
    return error(404, "not_found", "not found");
  const base = publicArtifactPath(env, artifact.url_key);
  if (url.pathname === base.slice(0, -1) || url.pathname.startsWith(base))
    return null;
  if (url.pathname === "/_au/artifact-icon.svg") return null;
  if (url.pathname.startsWith(`/_au/preview/${artifact.url_key}/`)) return null;
  if (
    !/^\/_au\/(comments|versions|artifact-context|agent-token|profile|gate\/(email|start|verify|link))$/.test(
      url.pathname,
    )
  )
    return error(404, "not_found", "not found");
  let key = url.searchParams.get("artifact_key");
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const copy = request.clone();
      key = (request.headers.get("Content-Type") || "").includes(
        "application/json",
      )
        ? String(
            ((await copy.json()) as { artifact_key?: unknown }).artifact_key ||
              "",
          )
        : String((await copy.formData()).get("artifact_key") || "");
    } catch {
      return error(400, "invalid_request", "artifact_key is required");
    }
  }
  return key === artifact.url_key ? null : error(404, "not_found", "not found");
}

export function protectTrustedArtifactContent(
  request: Request,
  env: Env,
  response: Response,
): Response {
  if (
    sharedOriginArtifacts(env) ||
    !isTrustedOrigin(request, env) ||
    !(
      response.headers.has("X-Artifact-Version") ||
      response.headers.has("X-Artifact-Upstream")
    )
  )
    return response;
  const headers = new Headers(response.headers);
  // Agents still receive the original bytes; a browser cannot execute them
  // with the publisher origin, even if isolation configuration is missing
  // (only ARTIFACT_SHARED_ORIGIN, set on purpose, serves them live here).
  headers.set("Content-Security-Policy", "sandbox; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function redirectToArtifactOrigin(
  request: Request,
  env: Env,
  artifact: Artifact,
  session: ViewerSession | null,
): Promise<Response | null> {
  const origin = artifactOrigin(env, artifact);
  if (!origin || !isTrustedOrigin(request, env)) return null;
  const destination = new URL(request.url);
  const target = new URL(origin);
  destination.host = target.host;
  destination.protocol = target.protocol;
  destination.searchParams.delete("au_sso");
  destination.searchParams.delete("__au_handoff");
  const challenge = destination.searchParams.get("__au_challenge") || "";
  destination.searchParams.delete("__au_challenge");
  destination.searchParams.delete("__au_auth");
  destination.searchParams.delete("__au_state");
  if (session) {
    if (!/^[a-f0-9]{64}$/.test(challenge)) {
      // Establish state on the destination host first. A transferable URL
      // must never be able to replace another browser's comment identity.
      destination.searchParams.set("__au_auth", "1");
      return new Response(null, {
        status: 302,
        headers: {
          Location: destination.toString(),
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const code = randomId("hop");
    const now = nowSec();
    await env.DB.prepare("DELETE FROM artifact_handoffs WHERE expires_at < ?")
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO artifact_handoffs (code_hash, artifact_id, session_token, expires_at, challenge_hash) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        await sha256Hex(code),
        artifact.id,
        await signViewerSession(session, env),
        Math.min(session.exp, now + 60),
        challenge,
      )
      .run();
    destination.searchParams.set("__au_handoff", code);
    destination.searchParams.set("__au_state", challenge);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.toString(),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function consumeArtifactHandoff(
  request: Request,
  env: Env,
  artifact: Artifact,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.searchParams.get("__au_auth") === "1" &&
    !isTrustedOrigin(request, env) &&
    request.method === "GET"
  ) {
    const mode = request.headers.get("Sec-Fetch-Mode");
    const dest = request.headers.get("Sec-Fetch-Dest");
    if ((mode && mode !== "navigate") || (dest && dest !== "document"))
      return error(
        403,
        "navigation_required",
        "open the artifact in a browser tab",
      );
    const nonce = randomId("state");
    const binding = await sha256Hex(nonce);
    const state = await signPayload(
      {
        typ: "artifact_handoff_state",
        artifact_id: artifact.id,
        nonce,
        exp: nowSec() + 120,
      },
      env,
    );
    const trusted = new URL(env.SITE_BASE_URL);
    url.host = trusted.host;
    url.protocol = trusted.protocol;
    url.searchParams.delete("__au_auth");
    url.searchParams.delete("__au_handoff");
    url.searchParams.delete("__au_state");
    url.searchParams.set("__au_challenge", binding);
    return new Response(null, {
      status: 303,
      headers: {
        Location: url.toString(),
        "Set-Cookie": `__Host-au_handoff_${binding}=${encodeURIComponent(state)}; Path=/; Max-Age=120; Secure; HttpOnly; SameSite=Lax`,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  const code = url.searchParams.get("__au_handoff");
  if (!code) return null;
  if (isTrustedOrigin(request, env) || request.method !== "GET")
    return error(401, "invalid_handoff", "invalid or expired handoff");
  const binding = url.searchParams.get("__au_state") || "";
  const raw = /^[a-f0-9]{64}$/.test(binding)
    ? readCookie(request, `__Host-au_handoff_${binding}`)
    : null;
  const state = raw
    ? await verifyPayload<{
        typ: string;
        artifact_id: string;
        nonce: string;
        exp: number;
      }>(raw, env)
    : null;
  if (
    !state ||
    state.typ !== "artifact_handoff_state" ||
    state.artifact_id !== artifact.id ||
    state.exp < nowSec() ||
    typeof state.nonce !== "string"
  )
    return error(401, "invalid_handoff", "invalid or expired handoff");
  if ((await sha256Hex(state.nonce)) !== binding)
    return error(401, "invalid_handoff", "invalid or expired handoff");
  const row = await env.DB.prepare(
    "DELETE FROM artifact_handoffs WHERE code_hash = ? AND artifact_id = ? AND expires_at >= ? AND challenge_hash = ? RETURNING session_token",
  )
    .bind(
      await sha256Hex(code),
      artifact.id,
      nowSec(),
      await sha256Hex(state.nonce),
    )
    .first<{ session_token: string }>();
  const session = row
    ? await verifyViewerSession(row.session_token, env)
    : null;
  if (!row || !session || session.artifact_id !== artifact.id)
    return error(401, "invalid_handoff", "invalid or expired handoff");
  url.searchParams.delete("__au_handoff");
  url.searchParams.delete("__au_state");
  const headers = new Headers({
    Location: url.toString(),
    "Set-Cookie": setViewerCookie(
      viewerCookieName(artifact.id),
      row.session_token,
    ),
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append(
    "Set-Cookie",
    `__Host-au_handoff_${binding}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 303, headers });
}
