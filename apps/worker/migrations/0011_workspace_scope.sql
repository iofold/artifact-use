-- Multi-workspace publishing: a creator token may be scoped to one org
-- ('org', the historical default) or to its user ('user'), in which case the
-- workspace is selected per request and validated against live WorkOS
-- membership through the cache below.

ALTER TABLE creator_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';

-- Per-user snapshot of active WorkOS organization memberships. Rows are
-- refreshed together per user; workspace_membership_sync records when.
CREATE TABLE IF NOT EXISTS workspace_memberships (
  user_id    TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  org_name   TEXT NOT NULL DEFAULT '',
  org_slug   TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE IF NOT EXISTS workspace_membership_sync (
  user_id      TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL
);
