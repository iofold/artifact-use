-- Quick-connect prompt: /admin shows a ready one-paste agent prompt when the
-- workspace has not published in 7 days. The raw token is parked on its
-- registry row so reloads re-display the same prompt instead of minting a new
-- token per page view. The parked copy is only for display; verification
-- stays signature-based and revocation still works through revoked_at.
ALTER TABLE creator_tokens ADD COLUMN parked_token TEXT;
