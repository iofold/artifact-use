import type { Env } from "./types";
import { handleAdminApi } from "./admin";
import { safeCreator } from "./auth";
import { handlePublish } from "./publish";
import { error, json } from "./util";

const TOOLS = [
  {
    name: "artifact_use_publish_html",
    description:
      "Publish a single HTML artifact to the authenticated WorkOS organization.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact", "html"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        title: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        html: { type: "string" },
      },
    },
  },
  {
    name: "artifact_use_list_artifacts",
    description:
      "List artifacts visible to the authenticated WorkOS organization.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "artifact_use_set_gate",
    description: "Update an artifact gate level or allowlist.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact", "gate_level"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        gate_level: {
          type: "string",
          enum: ["public", "email", "verified_email", "allowlist"],
        },
        allowlist: { type: "object" },
      },
    },
  },
  {
    name: "artifact_use_create_share_link",
    description: "Create a tracked share link for an artifact.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact"],
      properties: {
        tenant: { type: "string" },
        artifact: { type: "string" },
        recipient_email: { type: "string" },
        recipient_label: { type: "string" },
        expires_days: { type: "number" },
      },
    },
  },
  {
    name: "artifact_use_get_stats",
    description:
      "Fetch artifact views, unique viewers, share links, and recent visits.",
    inputSchema: {
      type: "object",
      required: ["tenant", "artifact"],
      properties: { tenant: { type: "string" }, artifact: { type: "string" } },
    },
  },
];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET")
    return json({ name: "artifact-use", transport: "streamable-http-minimal" });
  if (request.method !== "POST")
    return error(405, "method_not_allowed", "POST required");
  const body = (await request.json()) as {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = body.id ?? null;
  try {
    if (body.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "artifact-use", version: "0.1.0" },
        },
      });
    }
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (body.method !== "tools/call")
      return json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found" },
      });
    const creator = await safeCreator(request, env);
    if (creator instanceof Response) return creator;
    const params = body.params || {};
    const name = String(params.name || "");
    const args = (params.arguments || {}) as Record<string, unknown>;
    const result = await callTool(request, env, name, args);
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      },
    });
  } catch (e) {
    return json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: e instanceof Error ? e.message : "tool failed",
      },
    });
  }
}

async function callTool(
  request: Request,
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = {
    Authorization: request.headers.get("Authorization") || "",
    "Content-Type": "application/json",
  };
  if (name === "artifact_use_publish_html") {
    const r = await handlePublish(
      new Request(new URL("/api/v1/publish/html", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      }),
      env,
      "/api/v1/publish/html",
    );
    return r.json();
  }
  if (name === "artifact_use_list_artifacts") {
    const r = await handleAdminApi(
      new Request(new URL("/api/v1/artifacts", request.url), {
        method: "GET",
        headers,
      }),
      env,
      "/api/v1/artifacts",
    );
    return r.json();
  }
  if (name === "artifact_use_set_gate") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(`/api/v1/artifacts/${tenant}/${artifact}`, request.url),
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            gate_level: args.gate_level,
            allowlist: args.allowlist,
          }),
        },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}`,
    );
    return r.json();
  }
  if (name === "artifact_use_create_share_link") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(
          `/api/v1/artifacts/${tenant}/${artifact}/share-links`,
          request.url,
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}/share-links`,
    );
    return r.json();
  }
  if (name === "artifact_use_get_stats") {
    const tenant = String(args.tenant || "");
    const artifact = String(args.artifact || "");
    const r = await handleAdminApi(
      new Request(
        new URL(`/api/v1/artifacts/${tenant}/${artifact}/stats`, request.url),
        { method: "GET", headers },
      ),
      env,
      `/api/v1/artifacts/${tenant}/${artifact}/stats`,
    );
    return r.json();
  }
  throw new Error(`unknown tool: ${name}`);
}
