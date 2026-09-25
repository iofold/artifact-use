import type { Env } from "./types";
import { handleAdminApi } from "./admin";
import { oauthResource, supportedScopes } from "./auth";
import { handleGateRoute } from "./gate";
import { llmsFullTxt, llmsTxt } from "./llms";
import { handleMcp } from "./mcp";
import { handleConnectApi } from "./connect";
import { handlePublish } from "./publish";
import { handleArtifactPreviewAsset } from "./preview";
import {
  errorPage,
  handleAdminUiApi,
  handleConnectPage,
  handlePublisherAdmin,
  handlePublisherAuth,
  renderPrivacyPolicy,
  renderHome,
  renderTermsOfService,
} from "./publisher";
import {
  handleAgentToken,
  handleArtifactContext,
  handleComments,
  servePublic,
} from "./serve";
import {
  expireStaleConnectRequests,
  notifyExpiringTokens,
  sweepAbandonedUploads,
} from "./maintenance";
import { UPSTREAM_PATH } from "./upstream";
import { error, json, secureSystemResponse, wantsHtml } from "./util";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization,Content-Length,Content-Type,X-Artifact-Sha256,X-Artifact-Use-Workspace",
  "Access-Control-Max-Age": "86400",
};

export default {
  // Cron (see [triggers] in wrangler.toml): abandoned upload sessions and
  // empty artifact shells are swept so limit-rejected packages stop leaking.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(sweepAbandonedUploads(env));
    ctx.waitUntil(notifyExpiringTokens(env));
    ctx.waitUntil(expireStaleConnectRequests(env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(path);
    if (request.method === "OPTIONS") {
      const response = new Response(
        null,
        cors ? { status: 204, headers: cors } : { status: 204 },
      );
      return secureSystemResponse(path, response);
    }
    const response = secureSystemResponse(
      path,
      await htmlErrorAdapter(
        request,
        env,
        path,
        await route(request, env, path),
      ),
    );
    const headers = new Headers(response.headers);
    if (cors) for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

// Agent-facing surfaces keep their JSON error envelopes even in a browser tab.
const AGENT_PATHS = /^\/(api\/|mcp$|_au\/|\.well-known\/|llms)/;

// JSON error envelopes are the right contract for agents, but a person in a
// browser should get a designed page with a way home instead of raw JSON.
async function htmlErrorAdapter(
  request: Request,
  env: Env,
  path: string,
  response: Response,
): Promise<Response> {
  if (response.status < 400) return response;
  if (!wantsHtml(request)) return response;
  if (AGENT_PATHS.test(path) || UPSTREAM_PATH.test(path)) return response;
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) return response;
  let detail = "";
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: string };
    };
    detail = body.error?.message || "";
  } catch {
    // keep the generic copy
  }
  const pretty = errorPage(env, response.status, detail);
  // Keep cookie mutations (e.g. auth-failure cleanup) from the original.
  for (const value of response.headers.getSetCookie())
    pretty.headers.append("Set-Cookie", value);
  return pretty;
}

function corsHeaders(path: string): typeof CORS | null {
  if (
    path === "/mcp" ||
    path.startsWith("/api/v1/") ||
    path.startsWith("/.well-known/oauth-")
  ) {
    return CORS;
  }
  return null;
}

async function route(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  try {
    // `await` is load-bearing: `return dispatch(...)` would hand the promise
    // straight through and rejected handlers would skip this catch, escaping
    // as raw 1101 worker exceptions.
    return await dispatch(request, env, path);
  } catch (e) {
    return error(
      500,
      "internal_error",
      e instanceof Error ? e.message : "internal error",
    );
  }
}

async function dispatch(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  {
    if (path === "/.well-known/oauth-protected-resource") {
      return json({
        resource: oauthResource(env),
        authorization_servers: [env.WORKOS_AUTHKIT_URL],
        bearer_methods_supported: ["header"],
        scopes_supported: supportedScopes(env),
      });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(await authorizationServerMetadata(env));
    }
    if (path === "/.well-known/openai-apps-challenge")
      return openaiAppsChallenge(request, env);
    if (path === "/") return renderHome(request, env);
    if (path === "/privacy") return renderPrivacyPolicy(env);
    if (path === "/terms") return renderTermsOfService(env);
    if (path === "/robots.txt") return robotsTxt();
    if (path === "/favicon.ico")
      return Response.redirect(
        `${env.SITE_BASE_URL.replace(/\/$/, "")}/_au/artifact-icon.svg`,
        301,
      );
    if (path === "/llms.txt") return llmsTxt(env);
    if (path === "/llms-full.txt") return llmsFullTxt(env);
    if (
      path === "/login" ||
      path === "/signin" ||
      path === "/signup" ||
      path === "/invite" ||
      path === "/callback" ||
      path === "/logout"
    )
      return handlePublisherAuth(request, env, path);
    if (path.startsWith("/api/admin/"))
      return error(
        410,
        "admin_api_retired",
        "admin API moved under /admin/api",
      );
    if (path.startsWith("/admin/api/"))
      return handleAdminUiApi(request, env, path);
    if (path === "/admin" || path.startsWith("/admin/"))
      return handlePublisherAdmin(request, env, path);
    if (path === "/health") return json({ ok: true, name: "artifact-use" });
    if (path === "/mcp") return handleMcp(request, env);
    if (path === "/connect") return handleConnectPage(request, env);
    if (path.startsWith("/api/v1/connect/"))
      return handleConnectApi(request, env, path);
    if (path.startsWith("/api/v1/publish/"))
      return handlePublish(request, env, path);
    if (path.startsWith("/api/v1/")) return handleAdminApi(request, env, path);
    if (path.startsWith("/_au/gate/"))
      return handleGateRoute(request, env, path);
    if (path === "/_au/artifact-icon.svg" || path.startsWith("/_au/preview/"))
      return handleArtifactPreviewAsset(request, env, path);
    if (path === "/_au/comments") return handleComments(request, env, path);
    if (path === "/_au/artifact-context")
      return handleArtifactContext(request, env);
    if (path === "/_au/agent-token") return handleAgentToken(request, env);
    // Artifact files are read-only; the reserved `_api/` upstream proxy under
    // an artifact accepts the write methods its backend does.
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !UPSTREAM_PATH.test(path)
    )
      return error(405, "method_not_allowed", "method not allowed");
    return servePublic(request, env, path);
  }
}

// OpenAI's app directory verifies that we control this domain by fetching
// this path and comparing the body to the token it issued, so the response
// is the bare token and nothing else. Unset (the default) keeps it a 404.
function openaiAppsChallenge(request: Request, env: Env): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return error(405, "method_not_allowed", "method not allowed");
  const token = (env.OPENAI_APPS_CHALLENGE_TOKEN || "").trim();
  if (!token) return error(404, "not_found", "not found");
  return new Response(token, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Artifact pages stay crawlable so their `noindex` header is seen and honored;
// only the operator and machine surfaces are kept out of crawlers entirely.
function robotsTxt(): Response {
  const body = [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /mcp",
    "Disallow: /_au/",
    "Disallow: /login",
    "Disallow: /signin",
    "Disallow: /signup",
    "Disallow: /invite",
    "Disallow: /callback",
    "Disallow: /logout",
    "Disallow: /connect",
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function authorizationServerMetadata(env: Env): Promise<unknown> {
  const authkit = env.WORKOS_AUTHKIT_URL.replace(/\/$/, "");
  const oauth = await fetch(
    `${authkit}/.well-known/oauth-authorization-server`,
  );
  if (oauth.ok) return oauth.json();
  const oidc = await fetch(`${authkit}/.well-known/openid-configuration`);
  if (oidc.ok) return oidc.json();
  return {
    issuer: env.WORKOS_ISSUER,
    authorization_endpoint: `${authkit}/oauth2/authorize`,
    token_endpoint: `${authkit}/oauth2/token`,
    jwks_uri: env.WORKOS_JWKS_URL,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
}
