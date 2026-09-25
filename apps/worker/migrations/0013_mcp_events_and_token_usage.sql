-- Phase 1 instrumentation and token lifecycle.
--
-- mcp_events records every hosted MCP request (and the API calls the MCP
-- tools dispatch to) so the operator can answer "which harness publishes,
-- how often does it fail, and why" — none of which was recorded before.
CREATE TABLE IF NOT EXISTS mcp_events (
  id               TEXT PRIMARY KEY,
  ts               INTEGER NOT NULL,
  org_id           TEXT,
  user_id          TEXT,
  token_id         TEXT,
  auth_kind        TEXT,             -- creator_token | oauth | dev | none
  client           TEXT,             -- normalized from clientInfo or User-Agent (claude-code, codex, claude-ai, ...)
  client_version   TEXT,
  user_agent       TEXT,
  protocol_version TEXT,
  method           TEXT NOT NULL,    -- initialize | tools/list | tools/call | server/discover | ...
  tool             TEXT,
  action           TEXT,
  ok               INTEGER NOT NULL DEFAULT 1,
  status           INTEGER,          -- HTTP-ish status of the underlying call
  error_code       TEXT,
  duration_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_events_ts ON mcp_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_events_org_ts ON mcp_events(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_events_client_ts ON mcp_events(client, ts DESC);

-- Creator tokens: when a token was last seen, and whether the expiry warning
-- email went out, so expiry stops being silent.
ALTER TABLE creator_tokens ADD COLUMN last_used_at INTEGER;
ALTER TABLE creator_tokens ADD COLUMN expiry_notified_at INTEGER;
