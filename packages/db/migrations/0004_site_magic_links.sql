-- Magic-link tokens for site admins. Separate from `magic_links` because
-- that table's admin_id is FK'd to the tenant `admins` table — and D1
-- enforces FK constraints, so a site_admin id can't be stored there.

CREATE TABLE site_magic_links (
  token         TEXT PRIMARY KEY,
  site_admin_id TEXT NOT NULL REFERENCES site_admins(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE INDEX idx_site_magic_links_expires ON site_magic_links(expires_at);
