-- One-use credentials transfer already-authorized viewers from the trusted
-- login origin to one artifact's isolated browser origin. No parent-domain
-- cookies or reusable viewer tokens are put in a redirect URL.
CREATE TABLE artifact_handoffs (
  code_hash TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  challenge_hash TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX artifact_handoffs_expiry ON artifact_handoffs(expires_at);
