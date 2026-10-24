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
} from "./auth";
import { error, nowSec, publicArtifactPath, randomId, sha256Hex } from "./util";

export function isTrustedOrigin(request: Request, env: Env): boolean {
  return (
    !env.SITE_BASE_URL ||
    new URL(request.url).origin === new URL(env.SITE_BASE_URL).origin
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
    !isTrustedOrigin(request, env) ||
    !(
      response.headers.has("X-Artifact-Version") ||
      response.headers.has("X-Artifact-Upstream")
    )
  )
    return response;
  const headers = new Headers(response.headers);
  // Agents still receive the original bytes; a browser cannot execute them
  // with the publisher origin, even if isolation configuration is missing.
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
  if (session) {
    const code = randomId("hop");
    const now = nowSec();
    await env.DB.prepare("DELETE FROM artifact_handoffs WHERE expires_at < ?")
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO artifact_handoffs (code_hash, artifact_id, session_token, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        await sha256Hex(code),
        artifact.id,
        await signViewerSession(session, env),
        Math.min(session.exp, now + 60),
      )
      .run();
    destination.searchParams.set("__au_handoff", code);
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
  const code = url.searchParams.get("__au_handoff");
  if (!code) return null;
  if (isTrustedOrigin(request, env) || request.method !== "GET")
    return error(401, "invalid_handoff", "invalid or expired handoff");
  const row = await env.DB.prepare(
    "DELETE FROM artifact_handoffs WHERE code_hash = ? AND artifact_id = ? AND expires_at >= ? RETURNING session_token",
  )
    .bind(await sha256Hex(code), artifact.id, nowSec())
    .first<{ session_token: string }>();
  const session = row
    ? await verifyViewerSession(row.session_token, env)
    : null;
  if (!row || !session || session.artifact_id !== artifact.id)
    return error(401, "invalid_handoff", "invalid or expired handoff");
  url.searchParams.delete("__au_handoff");
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.toString(),
      "Set-Cookie": setViewerCookie(
        viewerCookieName(artifact.id),
        row.session_token,
      ),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
