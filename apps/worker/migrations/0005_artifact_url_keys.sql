ALTER TABLE artifacts ADD COLUMN url_key TEXT;

UPDATE artifacts
SET url_key = slug || '-' || substr(lower(replace(id, 'art_', '')), 1, 6)
WHERE url_key IS NULL OR url_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_url_key
  ON artifacts(url_key);

CREATE TRIGGER IF NOT EXISTS artifacts_url_key_insert
BEFORE INSERT ON artifacts
WHEN NEW.url_key IS NULL OR NEW.url_key = '' OR NEW.url_key NOT GLOB '*-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.url_key must end with a 6-character code');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_url_key_update
BEFORE UPDATE OF url_key ON artifacts
WHEN NEW.url_key IS NULL OR NEW.url_key = '' OR NEW.url_key NOT GLOB '*-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.url_key must end with a 6-character code');
END;

CREATE TABLE IF NOT EXISTS super_admin_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_org_id TEXT,
  to_org_id TEXT,
  to_user_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_super_admin_events_artifact
  ON super_admin_events(artifact_id, created_at DESC);
