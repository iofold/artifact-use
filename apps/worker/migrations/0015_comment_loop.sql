-- Comment loop, phase 2. The only way an agent learned about a comment was
-- polling (36 of 41 polls in one measured run found nothing), 161 of 392
-- anchored comments carried a bare "div"/"line" label, viewers had no signal
-- that an agent was watching, and 17% of comments were agent-authored through
-- a human's session with no attribution.

-- Push delivery: a webhook receives comment events as signed JSON POSTs.
-- artifact_id NULL subscribes to every artifact in the workspace.
CREATE TABLE IF NOT EXISTS artifact_webhooks (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  artifact_id      TEXT,
  url              TEXT NOT NULL,
  secret           TEXT NOT NULL,
  events_json      TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  last_delivery_at INTEGER,
  last_status      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_artifact_webhooks_org
  ON artifact_webhooks(org_id, created_at DESC);

-- One row per (webhook, event). next_attempt_at NULL means delivered or given
-- up; the six-hourly cron retries whatever is due.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  delivered_at    INTEGER,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(next_attempt_at)
  WHERE delivered_at IS NULL AND next_attempt_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
  ON webhook_deliveries(webhook_id, created_at DESC);

-- "Send to agent": a viewer flags a thread root for the publishing agent.
ALTER TABLE comments ADD COLUMN sent_to_agent_at INTEGER;

-- Honest authorship: comments written with a creator token or a delegated
-- agent token are `agent`; the label is the token's name where it has one.
ALTER TABLE comments ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE comments ADD COLUMN agent_label TEXT;

-- Creator identities without an email were recorded under their WorkOS user
-- id; those rows were written by agents.
UPDATE comments SET author_kind = 'agent'
  WHERE email LIKE 'user\_%' ESCAPE '\';

-- Agent presence: the last time a creator identity listed this artifact's
-- comments, shown on the page as "an agent checked this page N min ago".
CREATE TABLE IF NOT EXISTS artifact_watch (
  artifact_id  TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  label        TEXT
);

-- page_path normalisation: `/go/x/`, `/go/x/index.html` and `/go/x` were three
-- keys for one page (61 vs 41 comments on one artifact). The canonical form
-- has no trailing `index.html` and no trailing slash.
UPDATE comments
  SET page_path = substr(page_path, 1, length(page_path) - length('index.html'))
  WHERE page_path LIKE '%/index.html';
UPDATE comments
  SET page_path = substr(page_path, 1, length(page_path) - length('index.htm'))
  WHERE page_path LIKE '%/index.htm';
UPDATE comments
  SET page_path = rtrim(page_path, '/')
  WHERE page_path LIKE '%/' AND length(page_path) > 1;
