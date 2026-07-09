import type { Env } from "./types";
import { handleAdminApi } from "./admin";
import { oauthResource, supportedScopes } from "./auth";
import { handleGateRoute } from "./gate";
import { llmsFullTxt, llmsTxt } from "./llms";
import { handleMcp } from "./mcp";
import { handleConnectApi } from "./connect";
import { handlePublish } from "./publish";
import {
  handleConnectPage,
  handlePublisherAdmin,
  handlePublisherAuth,
  renderPrivacyPolicy,
  renderHome,
  renderTermsOfService,
} from "./publisher";
import { handleAgentToken, handleComments, servePublic } from "./serve";
import { error, json } from "./util";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization,Content-Length,Content-Type,X-Artifact-Sha256",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(path);
    if (request.method === "OPTIONS")
      return new Response(
        null,
        cors ? { status: 204, headers: cors } : { status: 204 },
      );
    const response = await route(request, env, path);
    const headers = new Headers(response.headers);
    if (cors) for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

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
    if (path === "/") return renderHome(request, env);
    if (path === "/privacy") return renderPrivacyPolicy();
    if (path === "/terms") return renderTermsOfService();
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
    if (path === "/_au/comments") return handleComments(request, env, path);
    if (path === "/_au/agent-token") return handleAgentToken(request, env);
    if (request.method !== "GET" && request.method !== "HEAD")
      return error(405, "method_not_allowed", "method not allowed");
    return servePublic(request, env, path);
  } catch (e) {
    return error(
      500,
      "internal_error",
      e instanceof Error ? e.message : "internal error",
    );
  }
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
