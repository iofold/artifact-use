-- Registry for creator bearer tokens (au_creator_) and agent connect requests
-- (device-code style handoff). Token verification stays signature-based; this
-- registry adds listing and revocation on top. Tokens minted before this
-- migration carry no jti claim and remain valid until they expire.

CREATE TABLE IF NOT EXISTS creator_tokens (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  label       TEXT,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_creator_tokens_org
  ON creator_tokens(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connect_requests (
  device_code  TEXT PRIMARY KEY,
  user_code    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  agent_label  TEXT,
  token        TEXT,
  token_id     TEXT,
  org_id       TEXT,
  approved_by  TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connect_requests_user_code
  ON connect_requests(user_code, created_at DESC);
