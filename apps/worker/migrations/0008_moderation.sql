ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));
ALTER TABLE artifacts ADD COLUMN moderation_reason TEXT;
ALTER TABLE artifacts ADD COLUMN moderated_by TEXT;
ALTER TABLE artifacts ADD COLUMN moderated_at INTEGER;

CREATE TABLE org_suspensions (
  org_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE moderation_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('artifact', 'org')),
  artifact_id TEXT,
  org_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_moderation_events_created
  ON moderation_events(created_at DESC);
