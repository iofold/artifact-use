-- Private feedback. With feedback_mode = 'private', each viewer sees only the
-- threads they started (plus the workspace's replies in them); the
-- publishing workspace sees every thread. 'shared' keeps today's behaviour.
ALTER TABLE artifacts ADD COLUMN feedback_mode TEXT NOT NULL DEFAULT 'shared';

-- Who, besides the workspace, may see a thread written while the artifact was
-- private. Recorded at write time so switching the mode off never reveals a
-- thread that was written privately.
--   <email> or link:<id>  a verified identity (email code, Google, signed in,
--                         or a share link)
--   view:<id>             an unverified typed-email session (scoped to that
--                         session, since anyone can type an address)
--   workspace             a thread the workspace itself started
-- NULL means shared. Replies carry their root's value.
ALTER TABLE comments ADD COLUMN private_to TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_artifact_private
  ON comments(artifact_id, private_to);
