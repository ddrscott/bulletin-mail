-- Member sign-in for the archive browser (community hub 1/5).
--
-- Members (subscribers) never had a web identity — magic_links FKs to the
-- tenant `admins` table and site_magic_links to `site_admins`, so neither
-- can hold a member sign-in. This table follows the exact same
-- token + optional 6-digit code pattern, keyed by (tenant_id, email)
-- instead of an admin id, because one human may hold several `members`
-- rows (one per group) that all share an email.
--
-- No new auth SYSTEM: same magic-link mechanics, same 15-minute expiry,
-- same atomic-consume pattern (UPDATE ... WHERE used_at IS NULL AND
-- expires_at > now), same code-collision defense (code lookup is always
-- scoped to tenant_id + email).

CREATE TABLE member_magic_links (
  token       TEXT PRIMARY KEY,                      -- random 32-byte hex
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                         -- lowercased
  code        TEXT,                                  -- 6-digit paste-able code
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE INDEX idx_member_magic_links_code
  ON member_magic_links(code) WHERE code IS NOT NULL;
CREATE INDEX idx_member_magic_links_expires
  ON member_magic_links(expires_at);
