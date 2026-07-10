// Thin fetch layer over the worker's /api/admin/* JSON reads and the existing
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
};

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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
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
    headers: { "content-type": "application/json" },
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

export type SuperOverview = {
  me: { sub: string; email: string | null };
  site: Site;
  artifacts: SuperArtifact[];
  daily: { day: string; n: number }[];
  events: SuperEvent[];
};

export const api = {
  overview: () => getJson<Overview>("/api/admin/overview"),
  superOverview: () => getJson<SuperOverview>("/api/admin/super"),
  artifactDetail: (id: string) =>
    getJson<ArtifactDetail>(
      `/api/admin/artifact-detail?id=${encodeURIComponent(id)}`,
    ),
  connect: () => getJson<ConnectInfo>("/api/admin/connect"),
  team: () => getJson<TeamInfo>("/api/admin/team"),
  mintPrompt: (label: string, expiresDays: string) =>
    postJson<MintedPrompt>("/api/admin/agent-prompt", {
      label,
      expires_days: expiresDays,
    }),
};
