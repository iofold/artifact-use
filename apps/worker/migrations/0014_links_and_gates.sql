-- Share links become the sharing primitive (phase 2, links and gates).
--
-- kind:      'recipient' (the link itself is the credential for a named
--            person; views attributed to recipient_email, unverified),
--            'password' (viewer types a passcode; identity link:<id>),
--            'open' (anyone holding the unguessable id passes the gate).
-- Existing rows keep working unchanged as 'recipient'.
-- password_hash/password_salt: PBKDF2-SHA256 of the passcode; the passcode
--            itself is returned once at creation and never stored.
-- max_opens/open_count/last_opened_at: every gate pass through the link
--            counts once per viewer session, never per asset.
ALTER TABLE share_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'recipient';
ALTER TABLE share_links ADD COLUMN label TEXT;
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
ALTER TABLE share_links ADD COLUMN password_salt TEXT;
ALTER TABLE share_links ADD COLUMN max_opens INTEGER;
ALTER TABLE share_links ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN last_opened_at INTEGER;
