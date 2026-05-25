/**
 * D1 row types. Mirror the schema in migrations/0001_init.sql exactly.
 *
 * Keep enums in sync with PRD §7. Adding a new value here without adding it
 * to the corresponding worker handler is a bug.
 */

export type TenantPlan = "free" | "byo_domain";
export type TenantStatus = "active" | "suspended";

export type Tenant = {
  id: string;
  slug: string;
  display_name: string;
  byo_domain: string | null;
  plan: TenantPlan;
  created_at: number;
  status: TenantStatus;
};

export type PostingPolicy = "members" | "moderated" | "announce_only" | "open";
export type ReplyToPolicy = "list" | "sender";
export type ArchiveVisibility = "members" | "public" | "none";

export type Group = {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description: string | null;
  posting_policy: PostingPolicy;
  reply_to_policy: ReplyToPolicy;
  subject_prefix: string | null;
  archive_visibility: ArchiveVisibility;
  max_message_size: number;
  created_at: number;
};

export type MemberRole = "member" | "moderator" | "sender_only";
export type MemberDeliveryMode = "each" | "digest" | "paused";
export type MemberStatus = "active" | "bouncing" | "unsubscribed";

export type Member = {
  id: string;
  group_id: string;
  email: string;
  display_name: string | null;
  role: MemberRole;
  delivery_mode: MemberDeliveryMode;
  status: MemberStatus;
  bounce_count: number;
  last_bounce_at: number | null;
  joined_at: number;
};

export type MessageStatus =
  | "received"
  | "queued"
  | "sending"
  | "sent"
  | "rejected"
  | "held_moderation";

export type Message = {
  id: string;
  group_id: string;
  original_message_id: string | null;
  in_reply_to_outbound: string | null;
  thread_id: string;
  from_email: string;
  from_name: string | null;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  has_attachments: 0 | 1;
  status: MessageStatus;
  rejection_reason: string | null;
  received_at: number;
  sent_at: number | null;
};

export type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  content_id: string | null;
};

export type DeliveryStatus = "queued" | "sent" | "bounced" | "failed" | "suppressed";

export type Delivery = {
  id: string;
  message_id: string;
  member_id: string;
  status: DeliveryStatus;
  provider_message_id: string | null;
  error: string | null;
  attempted_at: number | null;
  delivered_at: number | null;
};

export type ModerationState = "pending" | "approved" | "rejected";

export type ModerationQueueRow = {
  id: string;
  message_id: string;
  group_id: string;
  state: ModerationState;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  created_at: number;
};

export type AdminRole = "admin" | "super_admin";

export type Admin = {
  id: string;
  tenant_id: string;
  email: string;
  role: AdminRole;
  created_at: number;
};

export type MagicLink = {
  token: string;
  admin_id: string;
  expires_at: number;
  used_at: number | null;
};

export type UnsubToken = {
  token: string;
  member_id: string;
  created_at: number;
};

export type AuditLogEntry = {
  id: string;
  tenant_id: string | null;
  actor: string | null;
  action: string;
  details: string | null;
  created_at: number;
};
