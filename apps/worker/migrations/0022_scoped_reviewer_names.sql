-- A publisher may label a recipient link with any email. Link possession
-- authorizes a name inside that artifact, never a global email profile.
CREATE TABLE artifact_profiles (
  artifact_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, email),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);

ALTER TABLE comments ADD COLUMN author_verified INTEGER NOT NULL DEFAULT 0;
UPDATE comments SET author_verified = 1
WHERE author_role = 'workspace'
   OR EXISTS (SELECT 1 FROM views v WHERE v.id = comments.view_id AND v.verified = 1);
