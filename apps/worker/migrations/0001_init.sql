CREATE TABLE IF NOT EXISTS tenants (
  org_id       TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT,
  owner_email  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  tenant_slug        TEXT NOT NULL,
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  gate_level         TEXT NOT NULL DEFAULT 'email',
  allowlist_json     TEXT,
  current_version_id TEXT,
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(org_id, slug),
  UNIQUE(tenant_slug, slug),
  FOREIGN KEY(org_id) REFERENCES tenants(org_id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_updated ON artifacts(org_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  entrypoint   TEXT NOT NULL DEFAULT 'index.html',
  manifest_json TEXT,
  total_size   INTEGER NOT NULL DEFAULT 0,
  file_count   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_versions_artifact_created ON artifact_versions(artifact_id, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_share_links_artifact ON share_links(artifact_id);

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
CREATE INDEX IF NOT EXISTS idx_views_artifact_ts ON views(artifact_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_views_email ON views(email);

CREATE TABLE IF NOT EXISTS viewer_tokens (
  token       TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_viewer_tokens_email ON viewer_tokens(artifact_id, email);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id  TEXT NOT NULL,
  view_id      INTEGER,
  email        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_artifact_created ON comments(artifact_id, created_at DESC);
