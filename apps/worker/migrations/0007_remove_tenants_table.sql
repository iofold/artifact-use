CREATE TABLE legacy_artifact_paths_rebuild (
  legacy_prefix TEXT NOT NULL,
  legacy_slug TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (legacy_prefix, legacy_slug)
);

INSERT OR IGNORE INTO legacy_artifact_paths_rebuild
  (legacy_prefix, legacy_slug, artifact_id, created_at)
SELECT tenant_slug, slug, id, CAST(strftime('%s','now') AS INTEGER)
FROM artifacts
WHERE tenant_slug IS NOT NULL AND tenant_slug <> '';

INSERT OR IGNORE INTO legacy_artifact_paths_rebuild
  (legacy_prefix, legacy_slug, artifact_id, created_at)
SELECT 'odin', 'sitemap-planner', id, CAST(strftime('%s','now') AS INTEGER)
FROM artifacts
WHERE id = 'art_00000000000000000000000000000000';

DROP TABLE legacy_artifact_paths;
ALTER TABLE legacy_artifact_paths_rebuild RENAME TO legacy_artifact_paths;

CREATE INDEX IF NOT EXISTS idx_legacy_artifact_paths_artifact
  ON legacy_artifact_paths(artifact_id);

CREATE TABLE artifact_files_copy AS SELECT * FROM artifact_files;
CREATE TABLE artifact_versions_copy AS SELECT * FROM artifact_versions;
CREATE TABLE share_links_copy AS SELECT * FROM share_links;
CREATE TABLE views_copy AS SELECT * FROM views;
CREATE TABLE viewer_tokens_copy AS SELECT * FROM viewer_tokens;
CREATE TABLE comments_copy AS SELECT * FROM comments;

CREATE TABLE artifacts_rebuild (
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

INSERT INTO artifacts_rebuild
  (id, org_id, slug, title, description, gate_level, allowlist_json,
   current_version_id, created_by, created_at, updated_at, url_key)
SELECT
  id, org_id, slug, title, description, gate_level, allowlist_json,
  current_version_id, created_by, created_at, updated_at, url_key
FROM artifacts;

DROP TABLE artifact_files;
DROP TABLE artifact_versions;
DROP TABLE share_links;
DROP TABLE views;
DROP TABLE viewer_tokens;
DROP TABLE comments;
DROP TABLE artifacts;

ALTER TABLE artifacts_rebuild RENAME TO artifacts;

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

CREATE TABLE artifact_versions (
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

INSERT INTO artifact_versions
  (id, artifact_id, org_id, status, entrypoint, manifest_json, total_size,
   file_count, created_by, created_at, completed_at)
SELECT
  id, artifact_id, org_id, status, entrypoint, manifest_json, total_size,
  file_count, created_by, created_at, completed_at
FROM artifact_versions_copy;

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

CREATE TABLE artifact_files (
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

INSERT INTO artifact_files
  (version_id, path, storage_key, content_type, size, sha256, uploaded_at)
SELECT version_id, path, storage_key, content_type, size, sha256, uploaded_at
FROM artifact_files_copy;

CREATE TABLE share_links (
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

INSERT INTO share_links
  (id, artifact_id, recipient_email, recipient_label, expires_at, revoked_at,
   created_by, created_at)
SELECT
  id, artifact_id, recipient_email, recipient_label, expires_at, revoked_at,
  created_by, created_at
FROM share_links_copy;

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

CREATE TABLE views (
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

INSERT INTO views
  (id, artifact_id, version_id, share_link_id, email, verified, ip_hash, ua,
   referrer, ts)
SELECT
  id, artifact_id, version_id, share_link_id, email, verified, ip_hash, ua,
  referrer, ts
FROM views_copy;

CREATE INDEX IF NOT EXISTS idx_views_artifact_ts
  ON views(artifact_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_views_email
  ON views(email);

CREATE TABLE viewer_tokens (
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

INSERT INTO viewer_tokens
  (token, artifact_id, email, code, expires_at, used_at, created_at,
   redirect_to, share_link_id)
SELECT
  token, artifact_id, email, code, expires_at, used_at, created_at,
  redirect_to, share_link_id
FROM viewer_tokens_copy;

CREATE INDEX IF NOT EXISTS idx_viewer_tokens_email
  ON viewer_tokens(artifact_id, email);

CREATE TABLE comments (
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

INSERT INTO comments
  (id, artifact_id, view_id, email, body, created_at, deleted_at, target_json,
   parent_comment_id, resolved_at, resolved_by)
SELECT
  id, artifact_id, view_id, email, body, created_at, deleted_at, target_json,
  parent_comment_id, resolved_at, resolved_by
FROM comments_copy;

CREATE INDEX IF NOT EXISTS idx_comments_artifact_created
  ON comments(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_parent_created
  ON comments(parent_comment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_comments_artifact_resolved
  ON comments(artifact_id, resolved_at);

DROP TABLE artifact_files_copy;
DROP TABLE artifact_versions_copy;
DROP TABLE share_links_copy;
DROP TABLE views_copy;
DROP TABLE viewer_tokens_copy;
DROP TABLE comments_copy;

DROP TABLE IF EXISTS tenants;
