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
  AdminRole,
  Delivery,
  DeliveryStatus,
  Group,
  Member,
  Message,
  MessageStatus,
  SiteAdmin,
  SubscriptionRequest,
  SubscriptionRequestState,
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
  "reply_to_policy, subject_prefix, archive_visibility, max_message_size, " +
  "subscribe_statement, created_at";
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

export type CreateGroupInput = {
  tenantId: string;
  name: string;                           // local-part — must match /^[a-z][a-z0-9-]*[a-z0-9]$/
  displayName: string;
  description: string | null;
  postingPolicy: "members" | "moderated" | "announce_only" | "open";
  replyToPolicy: "list" | "sender";
  subjectPrefix: string | null;
  archiveVisibility: "members" | "public" | "none";
  maxMessageSize: number;
  subscribeStatement: string | null;
};

/**
 * Insert a group. Returns the new id, or null if (tenant_id, name) is taken
 * (UNIQUE constraint). Caller is expected to have already validated `name`
 * against the local-part regex; we don't re-validate here.
 */
export async function createGroup(
  db: D1Database,
  input: CreateGroupInput,
): Promise<string | null> {
  const id = `g_${newUlid()}`;
  try {
    await db
      .prepare(
        `INSERT INTO groups
          (id, tenant_id, name, display_name, description, posting_policy,
           reply_to_policy, subject_prefix, archive_visibility, max_message_size,
           subscribe_statement, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.name,
        input.displayName,
        input.description,
        input.postingPolicy,
        input.replyToPolicy,
        input.subjectPrefix,
        input.archiveVisibility,
        input.maxMessageSize,
        input.subscribeStatement,
        Date.now(),
      )
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
}

export type UpdateGroupInput = {
  displayName?: string;
  description?: string | null;
  postingPolicy?: "members" | "moderated" | "announce_only" | "open";
  replyToPolicy?: "list" | "sender";
  subjectPrefix?: string | null;
  archiveVisibility?: "members" | "public" | "none";
  maxMessageSize?: number;
  subscribeStatement?: string | null;
};

/**
 * Patch a group's editable fields. Returns true if a row was affected.
 *
 * Intentionally does NOT allow changing `name` (local-part) or `tenant_id` —
 * both are referenced by existing message threads and member subscriptions.
 * Renaming a list is a "create + migrate" job, not an UPDATE.
 */
export async function updateGroup(
  db: D1Database,
  groupId: string,
  patch: UpdateGroupInput,
): Promise<boolean> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.displayName !== undefined) { sets.push("display_name = ?"); values.push(patch.displayName); }
  if (patch.description !== undefined) { sets.push("description = ?"); values.push(patch.description); }
  if (patch.postingPolicy !== undefined) { sets.push("posting_policy = ?"); values.push(patch.postingPolicy); }
  if (patch.replyToPolicy !== undefined) { sets.push("reply_to_policy = ?"); values.push(patch.replyToPolicy); }
  if (patch.subjectPrefix !== undefined) { sets.push("subject_prefix = ?"); values.push(patch.subjectPrefix); }
  if (patch.archiveVisibility !== undefined) { sets.push("archive_visibility = ?"); values.push(patch.archiveVisibility); }
  if (patch.maxMessageSize !== undefined) { sets.push("max_message_size = ?"); values.push(patch.maxMessageSize); }
  if (patch.subscribeStatement !== undefined) { sets.push("subscribe_statement = ?"); values.push(patch.subscribeStatement); }
  if (sets.length === 0) return false;
  values.push(groupId);
  const result = await db
    .prepare(`UPDATE groups SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return (result.meta.changes ?? 0) > 0;
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

// ---- Groups (admin views) ---------------------------------------------------

export type GroupWithStats = Group & {
  active_member_count: number;
  last_message_at: number | null;
};

export async function listGroupsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<GroupWithStats[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GROUP_COLS},
         (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.status = 'active') AS active_member_count,
         (SELECT MAX(received_at) FROM messages WHERE group_id = g.id) AS last_message_at
       FROM groups g WHERE tenant_id = ? ORDER BY name`,
    )
    .bind(tenantId)
    .all<GroupWithStats>();
  return results ?? [];
}

// ---- Members (admin views) --------------------------------------------------

/**
 * List members for a group. Admin views want to see every status (active,
 * bouncing, unsubscribed) — not just deliverable ones. Order: active first,
 * then by email. Capped at `limit` to avoid blowing up the JSON response for
 * very large groups; the admin UI paginates via `offset`.
 */
export async function listMembersByGroup(
  db: D1Database,
  groupId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<Member[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLS} FROM members WHERE group_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'bouncing' THEN 1 ELSE 2 END, email
       LIMIT ? OFFSET ?`,
    )
    .bind(groupId, limit, offset)
    .all<Member>();
  return results ?? [];
}

export type InsertMemberInput = {
  groupId: string;
  email: string;
  displayName: string | null;
  role: "member" | "moderator" | "sender_only";
  /**
   * Default 'pending_confirmation' — admin-added members must opt in via the
   * confirmation email. Pass 'active' explicitly when the caller already has
   * proof of opt-in (e.g. approving a request the user submitted themselves
   * via the public subscribe form).
   */
  status?: "active" | "pending_confirmation";
};

/**
 * Insert a member. Returns the new id, or null if (group_id, email) is taken
 * (UNIQUE constraint). Email is lowercased to match the index expectation.
 */
export async function insertMember(
  db: D1Database,
  input: InsertMemberInput,
): Promise<string | null> {
  const id = `m_${newUlid()}`;
  const status = input.status ?? "pending_confirmation";
  try {
    await db
      .prepare(
        `INSERT INTO members (id, group_id, email, display_name, role, delivery_mode, status, bounce_count, joined_at)
         VALUES (?, ?, ?, ?, ?, 'each', ?, 0, ?)`,
      )
      .bind(
        id,
        input.groupId,
        input.email.toLowerCase(),
        input.displayName,
        input.role,
        status,
        Date.now(),
      )
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
}

/**
 * Confirm a member who is currently in 'pending_confirmation'. Atomic — the
 * UPDATE predicate prevents a confirmation click from reviving an
 * unsubscribed member. Returns:
 *   - "confirmed" : status changed pending → active
 *   - "already"   : member is already active (idempotent re-click)
 *   - "not_found" : no member with that id, or status is neither pending
 *                   nor active (e.g. unsubscribed → confirmation no longer
 *                   valid; member would need to be re-added)
 */
export async function confirmMember(
  db: D1Database,
  memberId: string,
): Promise<"confirmed" | "already" | "not_found"> {
  const r = await db
    .prepare(
      "UPDATE members SET status = 'active' WHERE id = ? AND status = 'pending_confirmation'",
    )
    .bind(memberId)
    .run();
  if ((r.meta.changes ?? 0) > 0) return "confirmed";
  const row = await db
    .prepare("SELECT status FROM members WHERE id = ?")
    .bind(memberId)
    .first<{ status: string }>();
  if (!row) return "not_found";
  if (row.status === "active") return "already";
  return "not_found";
}

export async function updateMemberRole(
  db: D1Database,
  memberId: string,
  role: "member" | "moderator" | "sender_only",
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE members SET role = ? WHERE id = ?")
    .bind(role, memberId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Set a member's status. Admin "remove" calls this with 'unsubscribed' (per
 * PRD §8.4 — unsubscribe is a status change, not a delete, so historical
 * deliveries keep their FK target).
 */
export async function setMemberStatus(
  db: D1Database,
  memberId: string,
  status: "active" | "bouncing" | "unsubscribed",
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE members SET status = ? WHERE id = ?")
    .bind(status, memberId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ---- Admins -----------------------------------------------------------------

export async function getAdminByEmail(
  db: D1Database,
  tenantId: string,
  email: string,
): Promise<Admin | null> {
  return db
    .prepare(
      "SELECT id, tenant_id, email, role, display_name, created_at FROM admins " +
        "WHERE tenant_id = ? AND email = ?",
    )
    .bind(tenantId, email.toLowerCase())
    .first<Admin>();
}

/**
 * Total admin count across all tenants. Cheap (PRIMARY KEY scan). Used by the
 * per-tenant bootstrap check below — not by the site-admin bootstrap, which
 * uses countSiteAdmins().
 */
export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM admins")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Per-tenant admin count — drives the tenant-subdomain bootstrap flow. */
export async function countAdminsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM admins WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** List every tenant — used by the site admin dashboard. */
export async function listTenants(db: D1Database): Promise<Tenant[]> {
  const { results } = await db
    .prepare(`SELECT ${TENANT_COLS} FROM tenants ORDER BY display_name`)
    .all<Tenant>();
  return results ?? [];
}

/**
 * Change an admin row's role. Returns false if the row didn't exist.
 * Caller is responsible for the "don't demote the last admin" rule.
 */
export async function updateAdminRole(
  db: D1Database,
  adminId: string,
  role: AdminRole,
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE admins SET role = ? WHERE id = ?")
    .bind(role, adminId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Insert a tenant admin or moderator. Returns the new id, null on
 * (tenant_id, email) UNIQUE violation.
 */
export async function insertTenantAdmin(
  db: D1Database,
  input: { tenantId: string; email: string; role: AdminRole; displayName?: string | null },
): Promise<string | null> {
  const id = `a_${newUlid()}`;
  try {
    await db
      .prepare(
        "INSERT INTO admins (id, tenant_id, email, role, display_name, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        input.tenantId,
        input.email.toLowerCase(),
        input.role,
        input.displayName ?? null,
        Date.now(),
      )
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
}

/** Update an admin's own display_name. Used by /api/profile. */
export async function updateAdminDisplayName(
  db: D1Database,
  adminId: string,
  displayName: string | null,
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE admins SET display_name = ? WHERE id = ?")
    .bind(displayName, adminId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function deleteTenantAdmin(
  db: D1Database,
  adminId: string,
): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM admins WHERE id = ?")
    .bind(adminId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---- Site admins ------------------------------------------------------------

export async function countSiteAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM site_admins")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createSiteAdmin(
  db: D1Database,
  email: string,
  displayName: string | null = null,
): Promise<{ id: string }> {
  const id = `s_${newUlid()}`;
  await db
    .prepare(
      "INSERT INTO site_admins (id, email, role, display_name, created_at) " +
        "VALUES (?, ?, 'admin', ?, ?)",
    )
    .bind(id, email.toLowerCase(), displayName, Date.now())
    .run();
  return { id };
}

/** Update a site admin's own display_name. Used by /api/profile. */
export async function updateSiteAdminDisplayName(
  db: D1Database,
  siteAdminId: string,
  displayName: string | null,
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE site_admins SET display_name = ? WHERE id = ?")
    .bind(displayName, siteAdminId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getSiteAdminByEmail(
  db: D1Database,
  email: string,
): Promise<SiteAdmin | null> {
  return db
    .prepare(
      "SELECT id, email, role, display_name, created_at FROM site_admins WHERE email = ?",
    )
    .bind(email.toLowerCase())
    .first<SiteAdmin>();
}

export async function getSiteAdminById(
  db: D1Database,
  id: string,
): Promise<SiteAdmin | null> {
  return db
    .prepare(
      "SELECT id, email, role, display_name, created_at FROM site_admins WHERE id = ?",
    )
    .bind(id)
    .first<SiteAdmin>();
}

/**
 * Atomically create a new tenant + its first tenant admin. Site-admin flow.
 * Returns ids; caller is expected to send the magic link separately.
 */
export async function createTenantWithFirstAdmin(
  db: D1Database,
  input: { slug: string; displayName: string; adminEmail: string; adminDisplayName?: string | null },
): Promise<{ tenantId: string; adminId: string }> {
  const tenantId = `t_${newUlid()}`;
  const adminId = `a_${newUlid()}`;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tenants (id, slug, display_name, plan, created_at, status) " +
          "VALUES (?, ?, ?, 'free', ?, 'active')",
      )
      .bind(tenantId, input.slug, input.displayName, now),
    db
      .prepare(
        "INSERT INTO admins (id, tenant_id, email, role, display_name, created_at) " +
          "VALUES (?, ?, ?, 'admin', ?, ?)",
      )
      .bind(adminId, tenantId, input.adminEmail.toLowerCase(), input.adminDisplayName ?? null, now),
  ]);
  return { tenantId, adminId };
}

/**
 * Magic-link helpers for site admins. The site_magic_links table is FK'd to
 * site_admins (not to admins like `magic_links`), so it requires its own pair
 * of helpers parallel to createMagicLink / consumeMagicLink.
 */
export async function createSiteMagicLink(
  db: D1Database,
  token: string,
  siteAdminId: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO site_magic_links (token, site_admin_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(token, siteAdminId, expiresAt)
    .run();
}

/**
 * Atomic consume — same pattern as consumeMagicLink. UPDATE first with the
 * unused+not-expired predicate, then read back the site admin.
 */
export async function consumeSiteMagicLink(
  db: D1Database,
  token: string,
  now: number,
): Promise<SiteAdmin | null> {
  const updated = await db
    .prepare(
      "UPDATE site_magic_links SET used_at = ? " +
        "WHERE token = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(now, token, now)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) return null;

  const row = await db
    .prepare("SELECT site_admin_id FROM site_magic_links WHERE token = ?")
    .bind(token)
    .first<{ site_admin_id: string }>();
  if (!row) return null;
  return getSiteAdminById(db, row.site_admin_id);
}

/**
 * Bootstrap: create a tenant and its first admin in a single D1 batch so we
 * never end up with one row but not the other. Returns the new tenant + admin
 * ids on success. Rejects on UNIQUE slug collision.
 */
export type BootstrapResult = { tenantId: string; adminId: string };

export async function createTenantAndFirstAdmin(
  db: D1Database,
  input: { slug: string; displayName: string; email: string },
): Promise<BootstrapResult> {
  const tenantId = `t_${newUlid()}`;
  const adminId = `a_${newUlid()}`;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tenants (id, slug, display_name, plan, created_at, status) " +
          "VALUES (?, ?, ?, 'free', ?, 'active')",
      )
      .bind(tenantId, input.slug, input.displayName, now),
    db
      .prepare(
        "INSERT INTO admins (id, tenant_id, email, role, created_at) " +
          "VALUES (?, ?, ?, 'admin', ?)",
      )
      .bind(adminId, tenantId, input.email.toLowerCase(), now),
  ]);
  return { tenantId, adminId };
}

/**
 * Find every admin row matching this email. Sign-in doesn't know the tenant
 * up front; if one human is an admin for multiple tenants they get one magic
 * link per tenant, each scoped to a single admin_id (PRD §10).
 */
export async function getAdminsByEmail(
  db: D1Database,
  email: string,
): Promise<Admin[]> {
  const { results } = await db
    .prepare(
      "SELECT id, tenant_id, email, role, display_name, created_at FROM admins WHERE email = ?",
    )
    .bind(email.toLowerCase())
    .all<Admin>();
  return results ?? [];
}

export async function getAdminById(
  db: D1Database,
  id: string,
): Promise<Admin | null> {
  return db
    .prepare(
      "SELECT id, tenant_id, email, role, display_name, created_at FROM admins WHERE id = ?",
    )
    .bind(id)
    .first<Admin>();
}

/** Return every admin for a tenant. Used by the daily-digest cron. */
export async function listAdminsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<Admin[]> {
  const { results } = await db
    .prepare(
      "SELECT id, tenant_id, email, role, display_name, created_at FROM admins WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .all<Admin>();
  return results ?? [];
}

// ---- Subscription requests --------------------------------------------------

const SUBREQ_COLS =
  "id, group_id, email, display_name, about, state, decided_by, decided_at, " +
  "decided_note, created_at";

export type InsertSubscriptionRequestInput = {
  groupId: string;
  email: string;
  displayName: string;
  about: string | null;
};

/**
 * Insert a pending subscription request. Returns the new id, or null if there
 * is already a pending request from this email on this group (basic abuse +
 * duplicate guard — UNIQUE constraint is too aggressive because past
 * approved/rejected rows shouldn't block re-applying).
 */
export async function insertSubscriptionRequest(
  db: D1Database,
  input: InsertSubscriptionRequestInput,
): Promise<string | null> {
  const dupe = await db
    .prepare(
      `SELECT id FROM subscription_requests
       WHERE group_id = ? AND email = ? AND state = 'pending' LIMIT 1`,
    )
    .bind(input.groupId, input.email.toLowerCase())
    .first<{ id: string }>();
  if (dupe) return null;

  const id = `sr_${newUlid()}`;
  await db
    .prepare(
      `INSERT INTO subscription_requests
         (id, group_id, email, display_name, about, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      id,
      input.groupId,
      input.email.toLowerCase(),
      input.displayName,
      input.about,
      Date.now(),
    )
    .run();
  return id;
}

export async function getSubscriptionRequest(
  db: D1Database,
  id: string,
): Promise<SubscriptionRequest | null> {
  return db
    .prepare(`SELECT ${SUBREQ_COLS} FROM subscription_requests WHERE id = ?`)
    .bind(id)
    .first<SubscriptionRequest>();
}

export async function listPendingSubscriptionRequests(
  db: D1Database,
  groupId: string,
): Promise<SubscriptionRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SUBREQ_COLS} FROM subscription_requests
       WHERE group_id = ? AND state = 'pending'
       ORDER BY created_at DESC`,
    )
    .bind(groupId)
    .all<SubscriptionRequest>();
  return results ?? [];
}

/** Used by the daily digest — every pending row across a tenant's groups. */
export type PendingForTenantRow = SubscriptionRequest & {
  group_name: string;
  group_display_name: string;
};

export async function listPendingSubscriptionsForTenant(
  db: D1Database,
  tenantId: string,
): Promise<PendingForTenantRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sr.id, sr.group_id, sr.email, sr.display_name, sr.about, sr.state,
              sr.decided_by, sr.decided_at, sr.decided_note, sr.created_at,
              g.name AS group_name, g.display_name AS group_display_name
       FROM subscription_requests sr
       JOIN groups g ON g.id = sr.group_id
       WHERE g.tenant_id = ? AND sr.state = 'pending'
       ORDER BY g.name, sr.created_at DESC`,
    )
    .bind(tenantId)
    .all<PendingForTenantRow>();
  return results ?? [];
}

/** List every tenant id that has at least one pending request. Drives the cron. */
export async function listTenantsWithPending(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT g.tenant_id AS tenant_id
       FROM subscription_requests sr
       JOIN groups g ON g.id = sr.group_id
       WHERE sr.state = 'pending'`,
    )
    .all<{ tenant_id: string }>();
  return (results ?? []).map((r) => r.tenant_id);
}

/**
 * Atomically transition a pending request to approved/rejected. Returns true
 * if the row was the first to claim the decision (we won the race against any
 * concurrent click); false if it was already decided.
 */
export async function decideSubscriptionRequest(
  db: D1Database,
  id: string,
  state: Exclude<SubscriptionRequestState, "pending">,
  decidedBy: string,
  decidedNote: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE subscription_requests
       SET state = ?, decided_by = ?, decided_at = ?, decided_note = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .bind(state, decidedBy, Date.now(), decidedNote, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ---- Magic links ------------------------------------------------------------

export async function createMagicLink(
  db: D1Database,
  token: string,
  adminId: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO magic_links (token, admin_id, expires_at) VALUES (?, ?, ?)",
    )
    .bind(token, adminId, expiresAt)
    .run();
}

/**
 * Atomically consume a magic-link token. Returns the admin row on success.
 *
 * Implementation: do the UPDATE first with `used_at IS NULL AND expires_at >
 * now` as the predicate. `meta.changes === 1` proves we won the race against
 * any concurrent verify attempt. THEN look up the admin. A bare SELECT/UPDATE
 * sequence would let two simultaneous clicks both validate.
 */
export async function consumeMagicLink(
  db: D1Database,
  token: string,
  now: number,
): Promise<Admin | null> {
  const updated = await db
    .prepare(
      "UPDATE magic_links SET used_at = ? " +
        "WHERE token = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(now, token, now)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) return null;

  const row = await db
    .prepare("SELECT admin_id FROM magic_links WHERE token = ?")
    .bind(token)
    .first<{ admin_id: string }>();
  if (!row) return null;
  return getAdminById(db, row.admin_id);
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
