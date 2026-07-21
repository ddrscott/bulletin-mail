-- Weekly member digest (community hub 4/5).
--
-- digest_opt_out is a per-member flag, distinct from list unsubscribe:
-- an opted-out member still receives every list message; they just stop
-- getting the weekly activity recap. The opt-out route flips the flag on
-- EVERY member row sharing the email within the tenant, so one click opts
-- the human out regardless of how many groups they belong to. (A later
-- join to a new group re-defaults to 0 — acceptable: the digest footer
-- always carries the opt-out link.)
ALTER TABLE members ADD COLUMN digest_opt_out INTEGER NOT NULL DEFAULT 0;
