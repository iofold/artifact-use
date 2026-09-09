-- Per-artifact upstream proxy. A creator may point an artifact at one HTTPS
-- backend; gated viewers reach it through the reserved `_api/` path under the
-- artifact URL. The Worker enforces the artifact gate, then forwards the
-- request with the stored bearer secret, so the published page never holds a
-- backend credential and the backend never runs its own login.
CREATE TABLE IF NOT EXISTS artifact_upstreams (
  artifact_id TEXT PRIMARY KEY,
  base_url    TEXT NOT NULL,
  secret      TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
