-- Add a 6-digit paste-able code alongside the random magic-link token. The
-- column is nullable because not every magic-link row is reachable by code:
--   - /api/auth/request rows : populated (the user who asked for the link is
--                              expected on a different device or with a
--                              link-rewriting filter, and pastes the code)
--   - team-invite / bootstrap rows : null (the recipient can't anticipate a
--                              code arriving in their inbox; they just click
--                              the link)
--
-- Lookup pattern (see consumeMagicLinkByCode / consumeSiteMagicLinkByCode):
--   SELECT ... WHERE code = ? AND admin/email matches  → exactly one row.
-- Codes are short — collisions matter. The atomic UPDATE keeps WHERE
-- code = ? AND used_at IS NULL AND expires_at > ? so a stale, collided
-- code can't claim a fresher row.

ALTER TABLE magic_links      ADD COLUMN code TEXT;
ALTER TABLE site_magic_links ADD COLUMN code TEXT;

-- Indexes accelerate the verify-code lookup. Codes are sparse (15-min
-- expiry, so a few hundred outstanding at most), but a dedicated index
-- keeps the lookup constant-time even as the table grows over time.
CREATE INDEX idx_magic_links_code      ON magic_links(code)      WHERE code IS NOT NULL;
CREATE INDEX idx_site_magic_links_code ON site_magic_links(code) WHERE code IS NOT NULL;
