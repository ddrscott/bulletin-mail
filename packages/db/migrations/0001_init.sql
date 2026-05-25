-- BulletinMail initial schema. See PRD §7.
-- All timestamps are integer Unix milliseconds. All ids are 26-char ulids
-- unless noted.

-- Tenants (churches / organizations)
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,                -- e.g. 'firstpresby'
  display_name  TEXT NOT NULL,
  byo_domain    TEXT UNIQUE,                         -- nullable; e.g. 'firstpresby.org'
  plan          TEXT NOT NULL DEFAULT 'free',        -- 'free' | 'byo_domain'
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'       -- 'active' | 'suspended'
);
CREATE INDEX idx_tenants_byo_domain ON tenants(byo_domain) WHERE byo_domain IS NOT NULL;

-- Groups (lists)
CREATE TABLE groups (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,                 -- local-part, e.g. 'announcements'
  display_name        TEXT NOT NULL,
  description         TEXT,
  posting_policy      TEXT NOT NULL,                 -- 'members' | 'moderated' | 'announce_only' | 'open'
  reply_to_policy     TEXT NOT NULL DEFAULT 'list',  -- 'list' | 'sender'
  subject_prefix      TEXT,                          -- e.g. '[Announcements]'
  archive_visibility  TEXT NOT NULL DEFAULT 'members', -- 'members' | 'public' | 'none'
  max_message_size    INTEGER NOT NULL DEFAULT 10485760, -- 10 MB
  created_at          INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

-- Members (subscribers)
CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'member',    -- 'member' | 'moderator' | 'sender_only'
  delivery_mode   TEXT NOT NULL DEFAULT 'each',      -- 'each' | 'digest' | 'paused'
  status          TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'bouncing' | 'unsubscribed'
  bounce_count    INTEGER NOT NULL DEFAULT 0,
  last_bounce_at  INTEGER,
  joined_at       INTEGER NOT NULL,
  UNIQUE(group_id, email)
);
CREATE INDEX idx_members_email ON members(email);
CREATE INDEX idx_members_group_status ON members(group_id, status);

-- Messages (one per list send)
CREATE TABLE messages (
  id                    TEXT PRIMARY KEY,            -- our outbound Message-ID local part
  group_id              TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  original_message_id   TEXT,                        -- sender's original RFC 5322 Message-ID
  in_reply_to_outbound  TEXT,                        -- our prior outbound Message-ID (parent)
  thread_id             TEXT NOT NULL,               -- first message id in the thread
  from_email            TEXT NOT NULL,
  from_name             TEXT,
  subject               TEXT NOT NULL,
  body_text             TEXT,
  body_html             TEXT,
  has_attachments       INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL,               -- 'received' | 'queued' | 'sending' | 'sent' | 'rejected' | 'held_moderation'
  rejection_reason      TEXT,
  received_at           INTEGER NOT NULL,
  sent_at               INTEGER
);
CREATE INDEX idx_messages_group_received ON messages(group_id, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX idx_messages_orig_mid ON messages(original_message_id);

-- Attachments
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  content_id    TEXT                                 -- for inline images (cid:)
);

-- Deliveries (per-recipient send result)
CREATE TABLE deliveries (
  id                   TEXT PRIMARY KEY,
  message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id            TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status               TEXT NOT NULL,                -- 'queued' | 'sent' | 'bounced' | 'failed' | 'suppressed'
  provider_message_id  TEXT,
  error                TEXT,
  attempted_at         INTEGER,
  delivered_at         INTEGER,
  UNIQUE(message_id, member_id)
);
CREATE INDEX idx_deliveries_message ON deliveries(message_id);
CREATE INDEX idx_deliveries_provider ON deliveries(provider_message_id);

-- Moderation queue
CREATE TABLE moderation_queue (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,                        -- 'pending' | 'approved' | 'rejected'
  decided_by   TEXT,                                 -- admin_id
  decided_at   INTEGER,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_mod_queue_pending ON moderation_queue(group_id, state, created_at);

-- Tenant admins
CREATE TABLE admins (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',          -- 'admin' | 'super_admin'
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, email)
);

-- Magic links (passwordless auth)
CREATE TABLE magic_links (
  token       TEXT PRIMARY KEY,                      -- random 32-byte hex
  admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- One-click unsubscribe tokens (one per member, opaque)
CREATE TABLE unsub_tokens (
  token       TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- Audit log (lightweight; for debugging and abuse)
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  actor       TEXT,                                  -- 'system' | 'admin:<id>' | 'sender:<email>'
  action      TEXT NOT NULL,
  details     TEXT,                                  -- JSON
  created_at  INTEGER NOT NULL
);
