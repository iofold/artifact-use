-- Display names for comment authors.
--
-- profiles: the name a person chose, keyed by their verified email. Until
-- they set one, readers show the email's local part ("alice" for
-- alice@acme.com), so the table only holds names people actually typed.
CREATE TABLE IF NOT EXISTS profiles (
  email        TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- WorkOS user id -> email. Comments written with a workspace credential are
-- stored under the user id; this resolves them to a person. An empty email
-- records a user WorkOS no longer knows, so it is not looked up again.
CREATE TABLE IF NOT EXISTS workos_users (
  user_id    TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 'workspace' when the publishing workspace wrote the comment (a member or
-- a workspace credential); NULL for viewers. Names are free text, so this is
-- what marks the team's comments as the team's.
ALTER TABLE comments ADD COLUMN author_role TEXT;

-- Workspace credentials wrote as their user id; workspace-started threads in
-- private mode carry private_to = 'workspace'.
UPDATE comments SET author_role = 'workspace'
WHERE author_role IS NULL
  AND (email LIKE 'user\_%' ESCAPE '\' OR private_to = 'workspace');
