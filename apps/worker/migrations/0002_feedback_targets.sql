ALTER TABLE comments ADD COLUMN target_json TEXT;
ALTER TABLE viewer_tokens ADD COLUMN redirect_to TEXT;
ALTER TABLE viewer_tokens ADD COLUMN share_link_id TEXT;
