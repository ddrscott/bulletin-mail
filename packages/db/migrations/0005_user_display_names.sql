-- Display-name overrides for admins + site admins. Defaults null; the API
-- auto-fills from Gravatar on insert when possible, and the user can edit
-- their own row via /api/profile.

ALTER TABLE admins      ADD COLUMN display_name TEXT;
ALTER TABLE site_admins ADD COLUMN display_name TEXT;
