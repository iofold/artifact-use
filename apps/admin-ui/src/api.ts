// Thin fetch layer over the worker's /admin/api/* JSON reads and the existing
// form-POST write endpoints (same-origin session cookie auth on both).

export type Me = {
  sub: string;
  orgId: string;
  email: string | null;
  name: string | null;
  superAdmin: boolean;
  teamAdmin: boolean;
};

export type Site = {
  base: string;
  prefix: string;
  docsUrl: string;
  mcpUrl: string;
};

export type ArtifactRow = {
  id: string;
  slug: string;
  url_key: string;
  title: string;
  gate_level: string;
  status: "active" | "suspended";
  org_suspended: boolean;
  path: string;
  url: string;
  total_views: number;
  unique_viewers: number;
  last_view_ts: number | null;
  share_links: number;
  comment_count: number;
  open_comments: number;
  file_count: number;
  total_size: number;
  completed_at: number | null;
  updated_at: number;
  allowlist_lines: string;
};

export type DailyRow = { artifact_id: string; day: string; n: number };

export type RecentView = {
  artifact_id: string;
  title: string | null;
  url_key: string | null;
  slug: string | null;
  email: string;
  ts: number;
};

export type Overview = {
  me: Me;
  site: Site;
  totals: { views: number; viewers: number; views7d: number; feedback: number };
  artifacts: ArtifactRow[];
  daily: DailyRow[];
  recent: RecentView[];
};

export type ShareLink = {
  id: string;
  recipient_email: string | null;
  recipient_label: string | null;
  view_count: number;
  state: "active" | "expired" | "revoked";
  url: string;
};

export type Comment = {
  id: number;
  email: string;
  body: string;
  created_at: number;
  resolved_at: number | null;
};

export type ArtifactDetail = { shares: ShareLink[]; comments: Comment[] };

export type AgentToken = {
  id: string;
  label: string | null;
  source: string;
  created_at: number;
  expires_at: number;
};

export type ConnectInfo = {
  site: Site;
  quick: { prompt: string; expiresAt: number } | null;
  tokens: AgentToken[];
  pending: { code: string; agentLabel: string | null } | null;
};

export type ApprovedConnect = { approved: true; label: string };

export type TeamMember = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
};

export type TeamInvite = {
  id: string;
  email: string;
  role: string;
  state: string;
  expiresAt: string;
};

export type TeamInfo = {
  orgId: string;
  canManage: boolean;
  canEdit: boolean;
  error: string | null;
  members: TeamMember[];
  invitations: TeamInvite[];
};

export type MintedPrompt = { prompt: string; expiresAt: number; label: string };

export function adminCsrfToken(cookieHeader = document.cookie): string {
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== "au_admin_csrf") continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function adminHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("X-CSRF-Token", adminCsrfToken());
  return headers;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: adminHeaders({ accept: "application/json" }),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// Existing worker write endpoints accept form posts and answer with a
// redirect on success or an {error:{code,message}} JSON body on failure.
export async function postForm(
  action: string,
  fields: Record<string, string>,
): Promise<void> {
  const res = await fetch(action, {
    method: "POST",
    headers: adminHeaders(),
    body: new URLSearchParams(fields),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("signed out");
  }
  if (!res.ok && !res.redirected) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new Error(message);
  }
}

export async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export type SuperArtifact = {
  id: string;
  slug: string;
  url_key: string;
  title: string;
  gate_level: string;
  status: "active" | "suspended";
  moderation_reason: string | null;
  moderated_by: string | null;
  moderated_at: number | null;
  org_suspended: boolean;
  org_moderation_reason: string | null;
  org_id: string;
  created_by: string;
  path: string;
  url: string;
  total_views: number;
  share_links: number;
  comment_count: number;
  file_count: number;
  total_size: number;
  completed_at: number | null;
  updated_at: number;
};

export type SuperEvent = {
  id: string;
  action: string;
  artifact_id: string;
  artifact_title: string | null;
  actor_user_id: string;
  from_org_id: string | null;
  to_org_id: string | null;
  to_user_id: string | null;
  created_at: number;
};

export type SuperModerationEvent = {
  id: string;
  actor_user_id: string;
  scope: "artifact" | "org";
  artifact_id: string | null;
  artifact_title: string | null;
  artifact_url_key: string | null;
  org_id: string | null;
  action: "suspend" | "restore";
  reason: string | null;
  created_at: number;
};

export type SuperOverview = {
  me: { sub: string; email: string | null };
  site: Site;
  artifacts: SuperArtifact[];
  daily: { day: string; n: number }[];
  events: SuperEvent[];
  moderationEvents: SuperModerationEvent[];
};

export const api = {
  overview: () => getJson<Overview>("/admin/api/overview"),
  superOverview: () => getJson<SuperOverview>("/admin/api/super"),
  artifactDetail: (id: string) =>
    getJson<ArtifactDetail>(
      `/admin/api/artifact-detail?id=${encodeURIComponent(id)}`,
    ),
  connect: (code = "") =>
    getJson<ConnectInfo>(
      `/admin/api/connect${code ? `?code=${encodeURIComponent(code)}` : ""}`,
    ),
  team: () => getJson<TeamInfo>("/admin/api/team"),
  mintPrompt: (label: string, expiresDays: string) =>
    postJson<MintedPrompt>("/admin/api/agent-prompt", {
      label,
      expires_days: expiresDays,
    }),
  approveConnect: (code: string) =>
    postJson<ApprovedConnect>("/admin/api/connect/approve", { code }),
};
