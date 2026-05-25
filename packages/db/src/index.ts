/**
 * Typed query helpers over D1. Each function wraps a single prepared
 * statement to keep callers free of raw SQL — and to make it impossible to
 * forget the tenant-scope predicate on multi-tenant queries.
 *
 * All helpers take a D1Database as the first arg; callers pass `env.DB`.
 *
 * Selection patterns:
 *   - All SELECTs name explicit columns (no `SELECT *`) so adding a column
 *     later doesn't silently change the wire payload.
 *   - All INSERTs return the inserted row's id (or `meta.changes` for
 *     idempotent UPDATEs) so callers don't need a separate read.
 *   - Multi-tenant queries take tenant_id as the SECOND argument; never the
 *     primary key alone. Cross-tenant reads are a bug.
 */

import type {
  Admin,
  Delivery,
  DeliveryStatus,
  Group,
  Member,
  Message,
  MessageStatus,
  Tenant,
  UnsubToken,
} from "./types.js";
import { newUlid } from "@bulletinmail/shared";

export * from "./types.js";

// Column lists factored out to keep queries readable.
const TENANT_COLS =
  "id, slug, display_name, byo_domain, plan, created_at, status";
const GROUP_COLS =
  "id, tenant_id, name, display_name, description, posting_policy, " +
  "reply_to_policy, subject_prefix, archive_visibility, max_message_size, created_at";
const MEMBER_COLS =
  "id, group_id, email, display_name, role, delivery_mode, status, " +
  "bounce_count, last_bounce_at, joined_at";
const MESSAGE_COLS =
  "id, group_id, original_message_id, in_reply_to_outbound, thread_id, " +
  "from_email, from_name, subject, body_text, body_html, has_attachments, " +
  "status, rejection_reason, received_at, sent_at";

// ---- Tenants ----------------------------------------------------------------

export async function getTenantById(
  db: D1Database,
  id: string,
): Promise<Tenant | null> {
  return db
    .prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE id = ?`)
    .bind(id)
    .first<Tenant>();
}

export async function getTenantBySlug(
  db: D1Database,
  slug: string,
): Promise<Tenant | null> {
  return db
    .prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE slug = ?`)
    .bind(slug)
    .first<Tenant>();
}

export async function getTenantByByoDomain(
  db: D1Database,
  domain: string,
): Promise<Tenant | null> {
  return db
    .prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE byo_domain = ?`)
    .bind(domain)
    .first<Tenant>();
}

// ---- Groups -----------------------------------------------------------------

export async function getGroupById(
  db: D1Database,
  id: string,
): Promise<Group | null> {
  return db
    .prepare(`SELECT ${GROUP_COLS} FROM groups WHERE id = ?`)
    .bind(id)
    .first<Group>();
}

export async function getGroupByLocalpart(
  db: D1Database,
  tenantId: string,
  localpart: string,
): Promise<Group | null> {
  return db
    .prepare(
      `SELECT ${GROUP_COLS} FROM groups WHERE tenant_id = ? AND name = ?`,
    )
    .bind(tenantId, localpart)
    .first<Group>();
}

// ---- Members ----------------------------------------------------------------

export async function getMemberById(
  db: D1Database,
  id: string,
): Promise<Member | null> {
  return db
    .prepare(`SELECT ${MEMBER_COLS} FROM members WHERE id = ?`)
    .bind(id)
    .first<Member>();
}

export async function getMemberByEmail(
  db: D1Database,
  groupId: string,
  email: string,
): Promise<Member | null> {
  return db
    .prepare(
      `SELECT ${MEMBER_COLS} FROM members WHERE group_id = ? AND email = ?`,
    )
    .bind(groupId, email.toLowerCase())
    .first<Member>();
}

export async function listActiveMembers(
  db: D1Database,
  groupId: string,
): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLS} FROM members ` +
        `WHERE group_id = ? AND status = 'active' AND delivery_mode != 'paused'`,
    )
    .bind(groupId)
    .all<Member>();
  return results ?? [];
}

// ---- Messages ---------------------------------------------------------------

export async function getMessageByOriginalMessageId(
  db: D1Database,
  originalMessageId: string,
): Promise<Message | null> {
  return db
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE original_message_id = ?`,
    )
    .bind(originalMessageId)
    .first<Message>();
}

export async function getMessageById(
  db: D1Database,
  id: string,
): Promise<Message | null> {
  return db
    .prepare(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`)
    .bind(id)
    .first<Message>();
}

export type InsertMessageInput = {
  groupId: string;
  originalMessageId: string | null;
  inReplyToOutbound: string | null;
  threadId: string | null;          // null = new thread (use generated id)
  fromEmail: string;
  fromName: string | null;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  status: MessageStatus;
  receivedAt: number;
};

/**
 * Insert a message row. Returns the generated id (a fresh ulid). If
 * `threadId` is null we use the new id as the thread root, matching the
 * PRD §9.2 rule for new threads.
 */
export async function insertMessage(
  db: D1Database,
  input: InsertMessageInput,
): Promise<string> {
  const id = newUlid();
  const threadId = input.threadId ?? id;
  await db
    .prepare(
      `INSERT INTO messages (id, group_id, original_message_id, in_reply_to_outbound, ` +
        `thread_id, from_email, from_name, subject, body_text, body_html, has_attachments, ` +
        `status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.groupId,
      input.originalMessageId,
      input.inReplyToOutbound,
      threadId,
      input.fromEmail,
      input.fromName,
      input.subject,
      input.bodyText,
      input.bodyHtml,
      input.hasAttachments ? 1 : 0,
      input.status,
      input.receivedAt,
    )
    .run();
  return id;
}

export async function updateMessageStatus(
  db: D1Database,
  messageId: string,
  status: MessageStatus,
  sentAt: number | null = null,
): Promise<void> {
  await db
    .prepare("UPDATE messages SET status = ?, sent_at = ? WHERE id = ?")
    .bind(status, sentAt, messageId)
    .run();
}

// ---- Attachments ------------------------------------------------------------

export type InsertAttachmentInput = {
  messageId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
  contentId: string | null;
};

export async function insertAttachment(
  db: D1Database,
  input: InsertAttachmentInput,
): Promise<string> {
  const id = newUlid();
  await db
    .prepare(
      "INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      input.messageId,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.r2Key,
      input.contentId,
    )
    .run();
  return id;
}

// ---- Deliveries -------------------------------------------------------------

export type InsertDeliveryInput = {
  messageId: string;
  memberId: string;
  status: DeliveryStatus;
};

export async function insertDelivery(
  db: D1Database,
  input: InsertDeliveryInput,
): Promise<string> {
  const id = newUlid();
  await db
    .prepare(
      "INSERT INTO deliveries (id, message_id, member_id, status) VALUES (?, ?, ?, ?)",
    )
    .bind(id, input.messageId, input.memberId, input.status)
    .run();
  return id;
}

export async function updateDeliverySent(
  db: D1Database,
  messageId: string,
  memberId: string,
  providerMessageId: string,
  deliveredAt: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE deliveries SET status = 'sent', provider_message_id = ?, " +
        "attempted_at = ?, delivered_at = ? WHERE message_id = ? AND member_id = ?",
    )
    .bind(providerMessageId, deliveredAt, deliveredAt, messageId, memberId)
    .run();
}

export async function updateDeliveryFailed(
  db: D1Database,
  messageId: string,
  memberId: string,
  error: string,
  attemptedAt: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE deliveries SET status = 'failed', error = ?, attempted_at = ? " +
        "WHERE message_id = ? AND member_id = ?",
    )
    .bind(error, attemptedAt, messageId, memberId)
    .run();
}

export async function getDeliveryByProviderMessageId(
  db: D1Database,
  providerMessageId: string,
): Promise<Delivery | null> {
  return db
    .prepare(
      "SELECT id, message_id, member_id, status, provider_message_id, error, " +
        "attempted_at, delivered_at FROM deliveries WHERE provider_message_id = ?",
    )
    .bind(providerMessageId)
    .first<Delivery>();
}

// ---- Unsubscribe tokens -----------------------------------------------------

export type UnsubResolution = {
  token: UnsubToken;
  member: Member;
  group: Group;
};

/**
 * Look up the member + group behind an unsubscribe token. Two round-trips
 * instead of a JOIN — D1 is fast and this isn't a hot path. Used by the GET
 * handler to render a confirmation page showing what the user is about to
 * unsubscribe from.
 */
export async function resolveUnsubToken(
  db: D1Database,
  token: string,
): Promise<UnsubResolution | null> {
  const tokenRow = await db
    .prepare("SELECT token, member_id, created_at FROM unsub_tokens WHERE token = ?")
    .bind(token)
    .first<UnsubToken>();
  if (!tokenRow) return null;

  const member = await db
    .prepare(`SELECT ${MEMBER_COLS} FROM members WHERE id = ?`)
    .bind(tokenRow.member_id)
    .first<Member>();
  if (!member) return null;

  const group = await db
    .prepare(`SELECT ${GROUP_COLS} FROM groups WHERE id = ?`)
    .bind(member.group_id)
    .first<Group>();
  if (!group) return null;

  return { token: tokenRow, member, group };
}

/**
 * Get just the token for outbound MIME building. The sender worker calls this
 * per recipient — keep it cheap (single-row PK lookup on unsub_tokens).
 */
export async function getOrCreateUnsubToken(
  db: D1Database,
  memberId: string,
): Promise<string> {
  const existing = await db
    .prepare("SELECT token FROM unsub_tokens WHERE member_id = ?")
    .bind(memberId)
    .first<{ token: string }>();
  if (existing) return existing.token;

  // Generate a random opaque token. We use 24 random bytes hex-encoded (48
  // chars). PRD §8.4 prefers opaque + per-member; the pepper from secrets is
  // applied at validation time (TBD; current impl is plain token lookup).
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  const token = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await db
    .prepare("INSERT INTO unsub_tokens (token, member_id, created_at) VALUES (?, ?, ?)")
    .bind(token, memberId, Date.now())
    .run();
  return token;
}

/**
 * Mark the member behind an unsubscribe token as 'unsubscribed'. Returns:
 *   - "unsubscribed" : member's status was changed (effective unsubscribe)
 *   - "already"      : token valid but member already unsubscribed (idempotent)
 *   - "not_found"    : no such token
 *
 * Token is left intact so re-clicks are idempotent (PRD §8.4).
 */
export async function unsubscribeByToken(
  db: D1Database,
  token: string,
): Promise<"unsubscribed" | "already" | "not_found"> {
  const tokenRow = await db
    .prepare("SELECT member_id FROM unsub_tokens WHERE token = ?")
    .bind(token)
    .first<{ member_id: string }>();
  if (!tokenRow) return "not_found";

  const result = await db
    .prepare(
      "UPDATE members SET status = 'unsubscribed' WHERE id = ? AND status != 'unsubscribed'",
    )
    .bind(tokenRow.member_id)
    .run();

  return (result.meta.changes ?? 0) > 0 ? "unsubscribed" : "already";
}

// ---- Admins -----------------------------------------------------------------

export async function getAdminByEmail(
  db: D1Database,
  tenantId: string,
  email: string,
): Promise<Admin | null> {
  return db
    .prepare(
      "SELECT id, tenant_id, email, role, created_at FROM admins " +
        "WHERE tenant_id = ? AND email = ?",
    )
    .bind(tenantId, email.toLowerCase())
    .first<Admin>();
}

// ---- Audit log --------------------------------------------------------------

export async function appendAudit(
  db: D1Database,
  entry: {
    tenantId: string | null;
    actor: string;
    action: string;
    details: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_log (id, tenant_id, actor, action, details, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      newUlid(),
      entry.tenantId,
      entry.actor,
      entry.action,
      entry.details ? JSON.stringify(entry.details) : null,
      Date.now(),
    )
    .run();
}
