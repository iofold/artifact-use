CREATE TABLE IF NOT EXISTS legacy_artifact_paths (
  legacy_tenant_slug TEXT NOT NULL,
  legacy_slug TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (legacy_tenant_slug, legacy_slug)
);

CREATE INDEX IF NOT EXISTS idx_legacy_artifact_paths_artifact
  ON legacy_artifact_paths(artifact_id);

INSERT OR IGNORE INTO legacy_artifact_paths
  (legacy_tenant_slug, legacy_slug, artifact_id, created_at)
SELECT 'odin', 'sitemap-planner', id, CAST(strftime('%s','now') AS INTEGER)
FROM artifacts
WHERE id = 'art_00000000000000000000000000000000';
