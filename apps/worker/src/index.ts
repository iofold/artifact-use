import type { Env } from "./types";
import { handleAdminApi } from "./admin";
import { handleGateRoute } from "./gate";
import { handleMcp } from "./mcp";
import { handlePublish } from "./publish";
import { handleComments, servePublic } from "./serve";
import { error, json } from "./util";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization,Content-Type,X-Artifact-Sha256",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });
    const response = await route(request, env, path);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

async function route(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  try {
    if (path === "/.well-known/oauth-protected-resource") {
      return json({
        resource: env.SITE_BASE_URL,
        authorization_servers: [env.WORKOS_AUTHKIT_URL],
        bearer_methods_supported: ["header"],
        scopes_supported: [
          "artifacts:publish",
          "artifacts:read",
          "artifacts:manage_access",
          "artifacts:view_stats",
        ],
      });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: env.WORKOS_ISSUER,
        authorization_endpoint: `${env.WORKOS_AUTHKIT_URL}/authorize`,
        token_endpoint: `${env.WORKOS_AUTHKIT_URL}/oauth2/token`,
        jwks_uri: env.WORKOS_JWKS_URL,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/health") return json({ ok: true, name: "artifact-use" });
    if (path === "/mcp") return handleMcp(request, env);
    if (path.startsWith("/api/v1/publish/"))
      return handlePublish(request, env, path);
    if (path.startsWith("/api/v1/")) return handleAdminApi(request, env, path);
    if (path.startsWith("/_au/gate/"))
      return handleGateRoute(request, env, path);
    if (path === "/_au/comments") return handleComments(request, env, path);
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
