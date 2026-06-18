ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER;
ALTER TABLE comments ADD COLUMN resolved_at INTEGER;
ALTER TABLE comments ADD COLUMN resolved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_parent_created
  ON comments(parent_comment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_comments_artifact_resolved
  ON comments(artifact_id, resolved_at);
