import type { Env } from "./types";

export function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class WorkosApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }

  static from(
    status: number,
    parsed: Record<string, unknown>,
    fallback: string,
  ): WorkosApiError {
    const message =
      stringClaim(parsed.message) ||
      stringClaim(parsed.error_description) ||
      stringClaim(parsed.error) ||
      stringClaim(parsed.code) ||
      fallback ||
      "WorkOS request failed";
    return new WorkosApiError(status, `WorkOS ${status}: ${message}`);
  }
}

export async function workosApi(
  env: Env,
  init: {
    path: string;
    method?: string;
    body?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!env.WORKOS_API_KEY) throw new Error("WorkOS API key is not configured");
  const headers = new Headers({
    Authorization: `Bearer ${env.WORKOS_API_KEY}`,
  });
  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  const requestInit: RequestInit = {
    method: init.method || "GET",
    headers,
  };
  if (body) requestInit.body = body;
  const res = await fetch(`https://api.workos.com${init.path}`, requestInit);
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw WorkosApiError.from(res.status, parsed, text);
  return parsed;
}

export async function workosApiMaybe(
  env: Env,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await workosApi(env, { path });
  } catch (e) {
    if (e instanceof WorkosApiError && e.status === 404) return null;
    throw e;
  }
}
