/**
 * Inbound Worker — Cloudflare Email Routing handler.
 *
 * Algorithm (PRD §8.1):
 *   1. Special case: `unsubscribe+<token>@<apex>` → unsubscribe and stop.
 *   2. Resolve recipient → (tenant, group). Reject 5.1.1 on miss.
 *   3. Parse MIME via postal-mime.
 *   4. Reject if message exceeds outbound send limit (5 MiB headroom).
 *   5. Validate envelope-sender against group.posting_policy.
 *   6. Resolve threading parent (In-Reply-To + References).
 *   7. INSERT message row; store attachments in R2 + INSERT attachment rows.
 *   8. INSERT delivery rows; enqueue one SendJob per active member.
 *
 * Time budget: < 5s CPU per message. Heavy work belongs in the send queue.
 */

import {
  loadFromEnv,
  type InstanceConfig,
} from "@bulletinmail/shared";
import {
  getTenantBySlug,
  getTenantByByoDomain,
  getGroupByLocalpart,
  getMemberByEmail,
  listActiveMembers,
  insertMessage,
  insertAttachment,
  insertDelivery,
  updateMessageStatus,
  unsubscribeByToken,
  appendAudit,
  type Group,
  type Tenant,
} from "@bulletinmail/db";
import { parseMessage, type ParsedMessage } from "@bulletinmail/mime";
import { resolveParent } from "@bulletinmail/mime";

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  SEND_QUEUE: Queue<SendJob>;
  [varName: string]: unknown;
}

export type SendJob = {
  messageId: string;
  memberId: string;
};

/** Maximum inbound size we accept. Email Routing caps at 25 MiB; we cap at
 *  ~4.5 MiB to leave headroom for outbound MIME expansion (Email Sending
 *  caps outbound at 5 MiB). PRD §17 #3 / #4. */
const MAX_ACCEPT_BYTES = 4_500_000;

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const config = loadFromEnv(env as unknown as Record<string, unknown>);

    // 1. Mailto unsubscribe special case — PRD §8.4.
    const unsubToken = extractUnsubToken(message.to, config);
    if (unsubToken !== null) {
      const outcome = await unsubscribeByToken(env.DB, unsubToken);
      await appendAudit(env.DB, {
        tenantId: null,
        actor: `sender:${message.from}`,
        action: "unsubscribe.mailto",
        details: { outcome, recipient: message.to },
      });
      return; // silent accept
    }

    // 2. Recipient → (tenant, group).
    const resolution = await resolveRecipient(env.DB, message.to, config);
    if (!resolution) {
      message.setReject("5.1.1 No such list");
      return;
    }
    const { tenant, group } = resolution;

    // 3. Bail early if oversize. The MIME parser must not run on huge messages.
    if (message.rawSize > MAX_ACCEPT_BYTES) {
      message.setReject(
        `5.3.4 Message too large (max ${Math.floor(MAX_ACCEPT_BYTES / 1024 / 1024)} MB; got ${Math.floor(message.rawSize / 1024 / 1024)} MB)`,
      );
      await appendAudit(env.DB, {
        tenantId: tenant.id,
        actor: `sender:${message.from}`,
        action: "inbound.rejected.oversize",
        details: { rawSize: message.rawSize, group: group.name },
      });
      return;
    }

    // 4. Parse MIME.
    let parsed: ParsedMessage;
    try {
      parsed = await parseMessage(message.raw);
    } catch (err) {
      message.setReject("5.6.0 Could not parse message");
      await appendAudit(env.DB, {
        tenantId: tenant.id,
        actor: `sender:${message.from}`,
        action: "inbound.rejected.parse_error",
        details: { error: String(err) },
      });
      return;
    }

    // 5. Validate envelope-sender per posting_policy. PRD §14 anti-pattern:
    //    trust SMTP envelope `from`, fall back to header `From` only if missing.
    const senderEmail = (message.from || parsed.fromEmail).toLowerCase();
    const validation = await validateSender(env.DB, group, senderEmail);
    if (!validation.ok) {
      message.setReject(`5.7.1 ${validation.reason}`);
      await appendAudit(env.DB, {
        tenantId: tenant.id,
        actor: `sender:${senderEmail}`,
        action: "inbound.rejected.policy",
        details: {
          group: group.name,
          policy: group.posting_policy,
          reason: validation.reason,
        },
      });
      return;
    }

    // 6. Reject if individual size exceeds the group's max_message_size.
    if (message.rawSize > group.max_message_size) {
      message.setReject(
        `5.3.4 Group max message size exceeded (${group.max_message_size} bytes)`,
      );
      return;
    }

    // 7. Resolve threading parent.
    const parent = await resolveParent(env.DB, {
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
    });

    // 8. INSERT the message row.
    const messageId = await insertMessage(env.DB, {
      groupId: group.id,
      originalMessageId: parsed.messageId,
      inReplyToOutbound: parent?.id ?? null,
      threadId: parent?.thread_id ?? null,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
      subject: parsed.subject || "(no subject)",
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      hasAttachments: parsed.attachments.length > 0,
      status: "received",
      receivedAt: parsed.receivedAt,
    });

    // 9. Store attachments in R2.
    for (const att of parsed.attachments) {
      const safeName = sanitizeFilename(att.filename);
      const r2Key = `attachments/${messageId}/${safeName}`;
      await env.ATTACHMENTS.put(r2Key, att.bytes, {
        httpMetadata: { contentType: att.contentType },
      });
      await insertAttachment(env.DB, {
        messageId,
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.bytes.byteLength,
        r2Key,
        contentId: att.contentId,
      });
    }

    if (parsed.strippedAttachments.length > 0) {
      await appendAudit(env.DB, {
        tenantId: tenant.id,
        actor: `sender:${senderEmail}`,
        action: "inbound.attachments.stripped",
        details: { messageId, filenames: parsed.strippedAttachments },
      });
    }

    // 10. Fan out per-recipient. Standard listserv behavior: the sender
    //     gets a copy too (so they see what landed in members' inboxes).
    //     A member can set delivery_mode='paused' to opt out of that.
    const members = await listActiveMembers(env.DB, group.id);
    for (const member of members) {
      await insertDelivery(env.DB, {
        messageId,
        memberId: member.id,
        status: "queued",
      });
      await env.SEND_QUEUE.send({ messageId, memberId: member.id });
    }

    await updateMessageStatus(env.DB, messageId, "queued");

    await appendAudit(env.DB, {
      tenantId: tenant.id,
      actor: `sender:${senderEmail}`,
      action: "inbound.accepted",
      details: {
        messageId,
        group: group.name,
        recipients: members.length,
        threadParent: parent?.id ?? null,
      },
    });
  },
};

// ---- helpers ----------------------------------------------------------------

/**
 * If `recipient` matches the configured unsubscribe-mailto pattern, return
 * the token. Else null.
 *
 * Pattern: `<prefix><token>@<apex>` where prefix is e.g. `unsubscribe+`.
 * Subdomain hosts do NOT match — the unsub mailto only lives at the apex.
 */
function extractUnsubToken(recipient: string, config: InstanceConfig): string | null {
  const lower = recipient.toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return null;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (domain !== config.apexDomain.toLowerCase()) return null;
  const prefix = config.unsubscribeAddressPrefix.toLowerCase();
  if (!local.startsWith(prefix)) return null;
  const token = local.slice(prefix.length);
  if (token.length === 0) return null;
  return token;
}

/**
 * Resolve a recipient address to its (tenant, group).
 *
 * Two paths:
 *   - Subdomain-per-tenant: `<group>@<slug>.<apex>` → tenant by slug.
 *   - BYO-domain tenant:    `<group>@<byo_domain>` → tenant by byo_domain.
 *
 * Returns null on any miss.
 */
async function resolveRecipient(
  db: D1Database,
  recipient: string,
  config: InstanceConfig,
): Promise<{ tenant: Tenant; group: Group } | null> {
  const lower = recipient.toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return null;
  const localPart = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  const apexSuffix = "." + config.apexDomain.toLowerCase();
  let tenant: Tenant | null = null;

  if (domain.endsWith(apexSuffix)) {
    const slug = domain.slice(0, -apexSuffix.length);
    // Reject multi-level subdomains (e.g. "x.y.firstpresby.apex") to keep
    // tenant slugs flat. classifyHost in @bulletinmail/shared has the
    // analogous rule for HTTP; we mirror it for email.
    if (slug.includes(".") || slug.length === 0) return null;
    tenant = await getTenantBySlug(db, slug);
  } else if (domain !== config.apexDomain.toLowerCase()) {
    // Could be a BYO-domain tenant.
    tenant = await getTenantByByoDomain(db, domain);
  }

  if (!tenant || tenant.status !== "active") return null;

  const group = await getGroupByLocalpart(db, tenant.id, localPart);
  if (!group) return null;

  return { tenant, group };
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

async function validateSender(
  db: D1Database,
  group: Group,
  senderEmail: string,
): Promise<ValidationResult> {
  switch (group.posting_policy) {
    case "open":
      return { ok: true };
    case "members": {
      const member = await getMemberByEmail(db, group.id, senderEmail);
      if (!member || member.status !== "active") {
        return { ok: false, reason: "Only active members may post to this list" };
      }
      return { ok: true };
    }
    case "announce_only": {
      const member = await getMemberByEmail(db, group.id, senderEmail);
      if (!member || member.status !== "active") {
        return { ok: false, reason: "This list does not accept posts from this address" };
      }
      if (member.role !== "moderator" && member.role !== "sender_only") {
        return { ok: false, reason: "Only authorized senders may post to this announce-only list" };
      }
      return { ok: true };
    }
    case "moderated":
      // For V1, defer moderation to V2 — bounce moderated posts back.
      return { ok: false, reason: "Moderation queue not yet implemented (V2)" };
    default: {
      const _exhaustive: never = group.posting_policy;
      return { ok: false, reason: `Unknown posting_policy: ${String(_exhaustive)}` };
    }
  }
}

function sanitizeFilename(name: string): string {
  // Strip path separators + control chars + leading dots. Preserve a usable
  // name; downstream R2 doesn't care, but a clean key is easier to debug.
  return name
    .replace(/[\\/\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 255) || "attachment";
}
