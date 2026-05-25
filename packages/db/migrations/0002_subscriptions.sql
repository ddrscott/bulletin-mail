-- Public subscribe form + pending-request queue.
--
-- The form lives at https://<tenant>.<apex>/join/<group>. Submissions go into
-- subscription_requests with state='pending'. Admins approve in the UI;
-- approval inserts a real members row. Moderators get a daily digest of
-- everything still pending across the tenant.

ALTER TABLE groups ADD COLUMN subscribe_statement TEXT;

CREATE TABLE subscription_requests (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  about         TEXT,                                  -- free-text 'about yourself'
  state         TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'approved' | 'rejected'
  decided_by    TEXT,                                  -- admin id
  decided_at    INTEGER,
  decided_note  TEXT,                                  -- moderator-visible reason
  created_at    INTEGER NOT NULL
);

-- Hot path: list pending submissions per group.
CREATE INDEX idx_subreq_group_state_created
  ON subscription_requests(group_id, state, created_at DESC);

-- Used to reject duplicate pending submissions from the same email to the same group.
CREATE INDEX idx_subreq_group_email ON subscription_requests(group_id, email);
