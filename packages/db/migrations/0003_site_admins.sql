-- Site admins — operators of the BulletinMail INSTANCE itself, not any one
-- tenant. They sign in at app.<apex> and create tenants. The first admin to
-- bootstrap on app.<apex> becomes the site admin.
--
-- Per-tenant admins/moderators remain in the existing `admins` table — that
-- table is the per-tenant authorization list. `admins.role` now also
-- recognizes 'moderator' (no DDL change — role is TEXT and was never
-- CHECK-constrained).

CREATE TABLE site_admins (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'admin',     -- 'admin' | 'super_admin'
  created_at INTEGER NOT NULL
);
