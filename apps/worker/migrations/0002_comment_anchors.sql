-- Associate each comment with a page and the artifact version it was left on.
-- page_path enables page scoping for untargeted comments (which have no
-- target_json); version_id enables version-drift detection on anchored ones.

ALTER TABLE comments ADD COLUMN page_path TEXT;
ALTER TABLE comments ADD COLUMN version_id TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_artifact_page
  ON comments(artifact_id, page_path);

-- Backfill page_path from the existing target_json.path where present.
UPDATE comments
SET page_path = json_extract(target_json, '$.path')
WHERE page_path IS NULL
  AND target_json IS NOT NULL
  AND json_extract(target_json, '$.path') IS NOT NULL;
