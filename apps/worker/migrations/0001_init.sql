-- Squashed baseline schema.
--
-- Production D1 has already recorded historical migration names 0001-0007.
-- Keep this as the only baseline for fresh databases, but number the next
-- production migration 0008 or higher so Wrangler does not skip it remotely.

CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  gate_level         TEXT NOT NULL DEFAULT 'email',
  allowlist_json     TEXT,
  current_version_id TEXT,
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  url_key            TEXT,
  UNIQUE(org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_org_updated
  ON artifacts(org_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_url_key
  ON artifacts(url_key);

CREATE TRIGGER IF NOT EXISTS artifacts_created_by_workos_insert
BEFORE INSERT ON artifacts
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_created_by_workos_update
BEFORE UPDATE OF created_by ON artifacts
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifacts.created_by must be a WorkOS user id');
END;

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

CREATE TABLE IF NOT EXISTS artifact_versions (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  entrypoint    TEXT NOT NULL DEFAULT 'index.html',
  manifest_json TEXT,
  total_size    INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_versions_artifact_created
  ON artifact_versions(artifact_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS artifact_versions_created_by_workos_insert
BEFORE INSERT ON artifact_versions
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS artifact_versions_created_by_workos_update
BEFORE UPDATE OF created_by ON artifact_versions
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions.created_by must be a WorkOS user id');
END;

CREATE TABLE IF NOT EXISTS artifact_files (
  version_id   TEXT NOT NULL,
  path         TEXT NOT NULL,
  storage_key  TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  uploaded_at  INTEGER NOT NULL,
  PRIMARY KEY(version_id, path),
  FOREIGN KEY(version_id) REFERENCES artifact_versions(id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id              TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL,
  recipient_email TEXT,
  recipient_label TEXT,
  expires_at      INTEGER,
  revoked_at      INTEGER,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_share_links_artifact
  ON share_links(artifact_id);

CREATE TRIGGER IF NOT EXISTS share_links_created_by_workos_insert
BEFORE INSERT ON share_links
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'share_links.created_by must be a WorkOS user id');
END;

CREATE TRIGGER IF NOT EXISTS share_links_created_by_workos_update
BEFORE UPDATE OF created_by ON share_links
WHEN NEW.created_by IS NULL OR NEW.created_by NOT GLOB 'user_*'
BEGIN
  SELECT RAISE(ABORT, 'share_links.created_by must be a WorkOS user id');
END;

CREATE TABLE IF NOT EXISTS views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id   TEXT NOT NULL,
  version_id    TEXT,
  share_link_id TEXT,
  email         TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  ip_hash       TEXT,
  ua            TEXT,
  referrer      TEXT,
  ts            INTEGER NOT NULL,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_views_artifact_ts
  ON views(artifact_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_views_email
  ON views(email);

CREATE TABLE IF NOT EXISTS viewer_tokens (
  token         TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL,
  email         TEXT NOT NULL,
  code          TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  created_at    INTEGER NOT NULL,
  redirect_to   TEXT,
  share_link_id TEXT,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_viewer_tokens_email
  ON viewer_tokens(artifact_id, email);

CREATE TABLE IF NOT EXISTS comments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id       TEXT NOT NULL,
  view_id           INTEGER,
  email             TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  target_json       TEXT,
  parent_comment_id INTEGER,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_artifact_created
  ON comments(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_parent_created
  ON comments(parent_comment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_comments_artifact_resolved
  ON comments(artifact_id, resolved_at);

CREATE TABLE IF NOT EXISTS legacy_artifact_paths (
  legacy_prefix TEXT NOT NULL,
  legacy_slug   TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (legacy_prefix, legacy_slug)
);

CREATE INDEX IF NOT EXISTS idx_legacy_artifact_paths_artifact
  ON legacy_artifact_paths(artifact_id);

CREATE TABLE IF NOT EXISTS super_admin_events (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  action        TEXT NOT NULL,
  from_org_id   TEXT,
  to_org_id     TEXT,
  to_user_id    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_super_admin_events_artifact
  ON super_admin_events(artifact_id, created_at DESC);
