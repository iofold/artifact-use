-- Honest analytics (phase 2): a view row says who looked and how it got in.
--
-- kind:   'human'      a browser driven by a person (the default)
--         'agent'      a coding agent or assistant fetching the page
--         'automation' headless browsers, HTTP clients, link unfurlers
-- source: 'gate'       an email / one-time-code gate pass
--         'link'       a share link passed the gate (or attributed the view)
--         'public'     a public artifact's HTML served to a person
--         'session'    a signed-in publisher passed through the gate
--
-- Dashboards count people (kind = 'human'); agents and automation are shown
-- separately, never mixed into the headline numbers. Classification happens
-- at insert time from the User-Agent (apps/worker/src/views.ts); the
-- backfill below applies the same families to rows recorded before the
-- column existed. Automation runs first so an agent marker wins on overlap,
-- matching classifyViewer's order.
ALTER TABLE views ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE views ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_views_artifact_kind_ts
  ON views(artifact_id, kind, ts);

UPDATE views SET kind = 'automation' WHERE ua IS NULL OR ua = ''
  OR ua LIKE '%HeadlessChrome%'
  OR ua LIKE '%curl/%'
  OR ua LIKE '%python-requests%'
  OR ua LIKE '%python-httpx%'
  OR ua LIKE '%Python-urllib%'
  OR ua LIKE '%aiohttp%'
  OR ua = 'node'
  OR ua LIKE 'node/%'
  OR ua LIKE 'node-fetch%'
  OR ua LIKE '%undici%'
  OR ua LIKE '%Bun/%'
  OR ua LIKE '%Go-http-client%'
  OR ua LIKE '%Wget/%'
  OR ua LIKE '%Slackbot%'
  OR ua LIKE '%facebookexternalhit%'
  OR ua LIKE '%Twitterbot%'
  OR ua LIKE '%WhatsApp%'
  OR ua LIKE '%TelegramBot%'
  OR ua LIKE '%Discordbot%'
  OR ua LIKE '%LinkedInBot%';

UPDATE views SET kind = 'agent' WHERE ua LIKE '%claude-code%'
  OR ua LIKE '%codex%'
  OR ua LIKE 'Claude-User%'
  OR ua LIKE '%ChatGPT-User%'
  OR ua LIKE '%hermes%'
  OR ua LIKE '%opencode%'
  OR ua LIKE '%cursor%'
  OR ua LIKE '%kiro%'
  OR ua LIKE 'Hypermodel-%';

-- Every row so far was written when a gate session was minted; a share link
-- id on the row means the link got the viewer in or attributed the view.
UPDATE views SET source = CASE
  WHEN share_link_id IS NOT NULL THEN 'link'
  ELSE 'gate'
END WHERE source IS NULL;
