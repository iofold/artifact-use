-- Idempotent comment writes. Clients (the widget outbox, agents) may send a
-- client-generated ref with POST /_au/comments; retries after a lost response
-- return the already-created comment instead of inserting a duplicate.
ALTER TABLE comments ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_client_ref
  ON comments(artifact_id, client_ref)
  WHERE client_ref IS NOT NULL;
