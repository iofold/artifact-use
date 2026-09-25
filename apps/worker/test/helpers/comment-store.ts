// In-memory D1 stand-in for the comment loop: routes the SQL that comments.ts,
// webhooks.ts and maintenance.ts issue onto plain arrays, so tests exercise
// the real handlers end to end without a database.
import type { Artifact, Env } from "../../src/types.ts";

export interface StoredComment {
  id: number;
  artifact_id: string;
  view_id: number | null;
  email: string;
  body: string;
  target_json: string | null;
  page_path: string | null;
  version_id: string | null;
  parent_comment_id: number | null;
  client_ref: string | null;
  created_at: number;
  deleted_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  sent_to_agent_at: number | null;
  author_kind: string;
  agent_label: string | null;
}

export interface StoredWebhook {
  id: string;
  org_id: string;
  artifact_id: string | null;
  url: string;
  secret: string;
  events_json: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  last_delivery_at: number | null;
  last_status: number | null;
}

export interface StoredDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: number | null;
  delivered_at: number | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
}

export interface Store {
  artifacts: Artifact[];
  comments: StoredComment[];
  webhooks: StoredWebhook[];
  deliveries: StoredDelivery[];
  watch: Map<string, { last_seen_at: number; label: string | null }>;
  statements: { sql: string; params: unknown[] }[];
  rateCount: number;
}

export function newStore(artifacts: Artifact[]): Store {
  return {
    artifacts,
    comments: [],
    webhooks: [],
    deliveries: [],
    watch: new Map(),
    statements: [],
    rateCount: 1,
  };
}

export function seedComment(
  store: Store,
  fields: Partial<StoredComment> & { artifact_id: string; body: string },
): StoredComment {
  const row: StoredComment = {
    id: store.comments.length + 1,
    view_id: null,
    email: "viewer@example.com",
    target_json: null,
    page_path: null,
    version_id: null,
    parent_comment_id: null,
    client_ref: null,
    created_at: 1_800_000_000,
    deleted_at: null,
    resolved_at: null,
    resolved_by: null,
    sent_to_agent_at: null,
    author_kind: "human",
    agent_label: null,
    ...fields,
  };
  store.comments.push(row);
  return row;
}

export function seedWebhook(
  store: Store,
  fields: Partial<StoredWebhook> & { org_id: string; url: string },
): StoredWebhook {
  const row: StoredWebhook = {
    id: `whk_${store.webhooks.length + 1}`,
    artifact_id: null,
    secret: "whsec_test",
    events_json: JSON.stringify([
      "comment.created",
      "comment.replied",
      "comment.resolved",
      "comment.reopened",
      "comment.sent_to_agent",
    ]),
    created_by: "user_seed",
    created_at: 1,
    revoked_at: null,
    last_delivery_at: null,
    last_status: null,
    ...fields,
  };
  store.webhooks.push(row);
  return row;
}

function commentRow(c: StoredComment): Record<string, unknown> {
  return { ...c };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fakeDb(store: Store): any {
  return {
    prepare(sql: string) {
      const make = (params: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        async first() {
          store.statements.push({ sql, params });
          return first(store, sql, params);
        },
        async all() {
          store.statements.push({ sql, params });
          return { results: all(store, sql, params) };
        },
        async run() {
          store.statements.push({ sql, params });
          return run(store, sql, params);
        },
      });
      return make([]);
    },
    async batch() {
      return [];
    },
  };
}

function first(store: Store, sql: string, params: unknown[]): unknown {
  if (sql.includes("INSERT INTO rate_counters"))
    return { count: store.rateCount };
  if (sql.includes("FROM artifacts a")) {
    if (sql.includes("a.url_key = ?"))
      return store.artifacts.find((a) => a.url_key === params[0]) || null;
    if (sql.includes("a.org_id = ? AND a.slug = ?"))
      return (
        store.artifacts.find(
          (a) => a.org_id === params[0] && a.slug === params[1],
        ) || null
      );
    return null;
  }
  if (sql.includes("FROM creator_tokens")) return null;
  if (sql.includes("FROM comments")) {
    const id = Number(params[0]);
    const row = store.comments.find(
      (c) => c.id === id && c.deleted_at === null,
    );
    if (!row) return null;
    if (
      sql.includes("AND artifact_id = ?") ||
      sql.includes("c.artifact_id = ?")
    )
      return row.artifact_id === params[1] ? commentRow(row) : null;
    return commentRow(row);
  }
  if (sql.includes("FROM artifact_watch")) {
    const row = store.watch.get(String(params[0]));
    return row ? { ...row } : null;
  }
  if (sql.includes("COUNT(*) AS n FROM artifact_webhooks"))
    return {
      n: store.webhooks.filter(
        (w) => w.org_id === params[0] && w.revoked_at === null,
      ).length,
    };
  return null;
}

function all(store: Store, sql: string, params: unknown[]): unknown[] {
  if (
    sql.includes("FROM comments c") &&
    sql.includes("LEFT JOIN comments root")
  ) {
    let i = 0;
    const artifactId = params[i++];
    const rootOf = (c: StoredComment) =>
      c.parent_comment_id
        ? store.comments.find((r) => r.id === c.parent_comment_id) || c
        : c;
    let rows = store.comments.filter(
      (c) => c.artifact_id === artifactId && c.deleted_at === null,
    );
    if (sql.includes("root.resolved_at END IS NULL"))
      rows = rows.filter((c) => rootOf(c).resolved_at === null);
    if (sql.includes("root.resolved_at END IS NOT NULL"))
      rows = rows.filter((c) => rootOf(c).resolved_at !== null);
    if (sql.includes("root.sent_to_agent_at END IS NOT NULL"))
      rows = rows.filter((c) => rootOf(c).sent_to_agent_at !== null);
    if (sql.includes("c.created_at > ?")) {
      const since = Number(params[i++]);
      rows = rows.filter((c) => c.created_at > since);
    }
    if (sql.includes("c.page_path = ?")) {
      const page = params[i++];
      rows = rows.filter((c) => c.page_path === page);
    }
    rows.sort((a, b) => {
      const ta = a.parent_comment_id || a.id;
      const tb = b.parent_comment_id || b.id;
      if (ta !== tb) return tb - ta;
      const ra = a.parent_comment_id ? 1 : 0;
      const rb = b.parent_comment_id ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return a.created_at - b.created_at;
    });
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] || 1000);
    return rows.slice(0, limit).map(commentRow);
  }
  if (sql.includes("FROM artifact_webhooks") && sql.includes("org_id = ?")) {
    if (sql.includes("artifact_id IS NULL OR artifact_id = ?"))
      return store.webhooks.filter(
        (w) =>
          w.org_id === params[0] &&
          w.revoked_at === null &&
          (w.artifact_id === null || w.artifact_id === params[1]),
      );
    return store.webhooks
      .filter((w) => w.org_id === params[0] && w.revoked_at === null)
      .map((w) => ({
        ...w,
        artifact_key:
          store.artifacts.find((a) => a.id === w.artifact_id)?.url_key || null,
        pending: store.deliveries.filter(
          (d) =>
            d.webhook_id === w.id &&
            d.delivered_at === null &&
            d.next_attempt_at !== null,
        ).length,
      }));
  }
  if (sql.includes("FROM webhook_deliveries d")) {
    const now = Number(params[0]);
    return store.deliveries
      .filter(
        (d) =>
          d.delivered_at === null &&
          d.next_attempt_at !== null &&
          d.next_attempt_at <= now,
      )
      .map((d) => {
        const w = store.webhooks.find((x) => x.id === d.webhook_id);
        return w
          ? { ...d, url: w.url, secret: w.secret, revoked_at: w.revoked_at }
          : null;
      })
      .filter(Boolean);
  }
  return [];
}

function run(
  store: Store,
  sql: string,
  params: unknown[],
): { meta: { changes: number; last_row_id: number } } {
  const meta = { changes: 0, last_row_id: 0 };
  if (sql.includes("INSERT INTO comments")) {
    const [
      artifact_id,
      view_id,
      email,
      body,
      target_json,
      page_path,
      version_id,
      parent_comment_id,
      client_ref,
      created_at,
      author_kind,
      agent_label,
    ] = params;
    if (
      client_ref &&
      store.comments.some(
        (c) => c.artifact_id === artifact_id && c.client_ref === client_ref,
      )
    )
      throw new Error("UNIQUE constraint failed: comments.client_ref");
    const row = seedComment(store, {
      artifact_id: String(artifact_id),
      view_id: view_id === null ? null : Number(view_id),
      email: String(email),
      body: String(body),
      target_json: (target_json as string | null) ?? null,
      page_path: (page_path as string | null) ?? null,
      version_id: (version_id as string | null) ?? null,
      parent_comment_id:
        parent_comment_id === null ? null : Number(parent_comment_id),
      client_ref: (client_ref as string | null) ?? null,
      created_at: Number(created_at),
      author_kind: String(author_kind),
      agent_label: (agent_label as string | null) ?? null,
    });
    meta.changes = 1;
    meta.last_row_id = row.id;
    return { meta };
  }
  if (sql.includes("UPDATE comments SET resolved_at")) {
    const [resolved_at, resolved_by, id] = params;
    const row = store.comments.find((c) => c.id === Number(id));
    if (row) {
      row.resolved_at = resolved_at as number | null;
      row.resolved_by = resolved_by as string | null;
      meta.changes = 1;
    }
    return { meta };
  }
  if (sql.includes("UPDATE comments SET sent_to_agent_at")) {
    const [sent_at, id] = params;
    const row = store.comments.find((c) => c.id === Number(id));
    if (row) {
      row.sent_to_agent_at = sent_at as number | null;
      meta.changes = 1;
    }
    return { meta };
  }
  if (sql.includes("UPDATE comments SET target_json")) {
    const [target_json, page_path, id] = params;
    const row = store.comments.find((c) => c.id === Number(id));
    if (row) {
      row.target_json = target_json as string;
      row.page_path = page_path as string;
      meta.changes = 1;
    }
    return { meta };
  }
  if (sql.includes("INSERT INTO artifact_watch")) {
    const [artifact_id, last_seen_at, label] = params as [
      string,
      number,
      string | null,
    ];
    const existing = store.watch.get(artifact_id);
    if (!existing) store.watch.set(artifact_id, { last_seen_at, label });
    else if (last_seen_at - existing.last_seen_at >= 60)
      store.watch.set(artifact_id, { last_seen_at, label });
    meta.changes = 1;
    return { meta };
  }
  if (sql.includes("INSERT INTO webhook_deliveries")) {
    const [id, webhook_id, event, payload_json, next_attempt_at, created_at] =
      params;
    store.deliveries.push({
      id: String(id),
      webhook_id: String(webhook_id),
      event: String(event),
      payload_json: String(payload_json),
      attempts: 0,
      next_attempt_at: Number(next_attempt_at),
      delivered_at: null,
      last_status: null,
      last_error: null,
      created_at: Number(created_at),
    });
    meta.changes = 1;
    return { meta };
  }
  if (
    sql.includes("UPDATE webhook_deliveries") &&
    sql.includes("SET attempts")
  ) {
    const [
      attempts,
      next_attempt_at,
      delivered_at,
      last_status,
      last_error,
      id,
    ] = params;
    const row = store.deliveries.find((d) => d.id === id);
    if (row) {
      row.attempts = Number(attempts);
      row.next_attempt_at = next_attempt_at as number | null;
      row.delivered_at = delivered_at as number | null;
      row.last_status = last_status as number | null;
      row.last_error = last_error as string | null;
      meta.changes = 1;
    }
    return { meta };
  }
  if (
    sql.includes(
      "UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE id",
    )
  ) {
    const row = store.deliveries.find((d) => d.id === params[0]);
    if (row) {
      row.next_attempt_at = null;
      meta.changes = 1;
    }
    return { meta };
  }
  if (
    sql.includes(
      "UPDATE webhook_deliveries SET next_attempt_at = NULL WHERE webhook_id",
    )
  ) {
    for (const d of store.deliveries)
      if (d.webhook_id === params[0] && d.delivered_at === null) {
        d.next_attempt_at = null;
        meta.changes += 1;
      }
    return { meta };
  }
  if (sql.includes("UPDATE artifact_webhooks SET last_delivery_at")) {
    const [last_delivery_at, last_status, id] = params;
    const row = store.webhooks.find((w) => w.id === id);
    if (row) {
      row.last_delivery_at = Number(last_delivery_at);
      row.last_status = last_status as number | null;
      meta.changes = 1;
    }
    return { meta };
  }
  if (sql.includes("UPDATE artifact_webhooks SET revoked_at")) {
    const [revoked_at, id, org_id] = params;
    const row = store.webhooks.find(
      (w) => w.id === id && w.org_id === org_id && w.revoked_at === null,
    );
    if (row) {
      row.revoked_at = Number(revoked_at);
      meta.changes = 1;
    }
    return { meta };
  }
  if (sql.includes("INSERT INTO artifact_webhooks")) {
    const [
      id,
      org_id,
      artifact_id,
      url,
      secret,
      events_json,
      created_by,
      created_at,
    ] = params;
    store.webhooks.push({
      id: String(id),
      org_id: String(org_id),
      artifact_id: (artifact_id as string | null) ?? null,
      url: String(url),
      secret: String(secret),
      events_json: String(events_json),
      created_by: String(created_by),
      created_at: Number(created_at),
      revoked_at: null,
      last_delivery_at: null,
      last_status: null,
    });
    meta.changes = 1;
    return { meta };
  }
  return { meta: { changes: 1, last_row_id: 0 } };
}

export function storeEnv(store: Store, overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(store),
    SESSION_SECRET: "comment-loop-secret",
    SITE_BASE_URL: "https://artifacts.example.com",
    ARTIFACT_PUBLIC_PATH_PREFIX: "/go",
    DEV_AUTH_TOKEN: "local-publisher-token",
    DEV_AUTH_USER_ID: "user_01LOOPOWNER",
    DEV_AUTH_ORG_ID: "org_loop",
    DEV_AUTH_EMAIL: "publisher@example.com",
    ...overrides,
  } as unknown as Env;
}

export const loopArtifact: Artifact = {
  id: "art_loop",
  org_id: "org_loop",
  slug: "loop-demo",
  url_key: "loop-demo-abc123",
  title: "Loop demo",
  description: null,
  gate_level: "public",
  allowlist_json: null,
  current_version_id: "ver_loop",
  created_by: "user_01LOOPOWNER",
  created_at: 1,
  updated_at: 1,
  status: "active",
  moderation_reason: null,
  moderated_by: null,
  moderated_at: null,
  org_suspended: 0,
};
