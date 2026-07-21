/**
 * Web posting — inject a browser-composed post into the SAME list pipeline
 * an emailed post travels (community-hub roadmap part 2).
 *
 * There is no "forum post" content type. A web post becomes a `messages`
 * row exactly as workers/inbound would create one, and every outbound copy
 * is built by the SAME @bulletinmail/mime buildOutbound() the sender Worker
 * uses — so the From rewrite (DMARC alignment on the apex), In-Reply-To /
 * References threading, subject-prefix normalization, and List-Unsubscribe
 * headers are byte-identical to relayed mail. Email recipients and web
 * readers see one conversation.
 *
 * Fan-out runs in ctx.waitUntil with the web Worker's own EMAIL binding —
 * no Queues producer needed, which keeps single-tenant/free-mode deploys on
 * the free plan (task constraint: ≤100-member scale). Per-recipient
 * failures mark the delivery 'failed' and continue; there is no redrive,
 * matching the small-org blast radius the archive already accepts.
 *
 * Posting permission mirrors workers/inbound validateSender() exactly —
 * including the 'moderated' policy, which the email path currently bounces
 * ("Moderation queue not yet implemented (V2)"). Web posts to moderated
 * groups are refused with the same reason: if it couldn't enter the mail
 * pipeline, it doesn't exist (no web-only special case).
 */

import type { Group, Member, Tenant } from "@bulletinmail/db";
import {
  getMessageById,
  getOrCreateUnsubToken,
  insertDelivery,
  listActiveMembers,
  updateDeliveryFailed,
  updateDeliverySent,
  updateMessageStatus,
} from "@bulletinmail/db";
import {
  assertOutboundValid,
  buildOutbound,
  buildReferencesChain,
  OutboundAssertionFailure,
} from "@bulletinmail/mime";
import type { InstanceConfig } from "@bulletinmail/shared";

// ---- limits -----------------------------------------------------------------

/** Per-member posting rate limit: max posts within the window, any group of
 *  the tenant, any ingest path. Defense in depth alongside Turnstile. */
export const POST_RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 } as const;

export const MAX_SUBJECT_CHARS = 180;
export const MAX_BODY_CHARS = 32_000;

// ---- pure helpers (unit-tested in tests/web-post.test.ts) -------------------

export type PostPermission =
  | { ok: true; member: Member | null }
  | { ok: false; reason: string };

/**
 * May `member` (the viewer's membership row on this group, or null) post to
 * `group`? Pure mirror of workers/inbound validateSender() — same policy
 * branches, same reason strings, so web and email rejections read the same.
 */
export function postPermissionFor(group: Group, member: Member | null): PostPermission {
  const active = member && member.status === "active" ? member : null;
  switch (group.posting_policy) {
    case "open":
      return { ok: true, member: active };
    case "members":
      if (!active) {
        return { ok: false, reason: "Only active members may post to this list" };
      }
      return { ok: true, member: active };
    case "announce_only":
      if (!active) {
        return { ok: false, reason: "This list does not accept posts from this address" };
      }
      if (active.role !== "moderator" && active.role !== "sender_only") {
        return { ok: false, reason: "Only authorized senders may post to this announce-only list" };
      }
      return { ok: true, member: active };
    case "moderated":
      // Parity with the email path: inbound bounces moderated posts until the
      // moderation queue ships (V2). Web posts get the identical refusal.
      return { ok: false, reason: "Moderation queue not yet implemented (V2)" };
    default: {
      const _exhaustive: never = group.posting_policy;
      return { ok: false, reason: `Unknown posting_policy: ${String(_exhaustive)}` };
    }
  }
}

/**
 * Subject for a web reply to a thread whose root subject is `rootSubject`.
 * Mirrors what a mail client does on "Reply": prepend `Re: ` unless the
 * subject already carries a reply marker (never `Re: Re:`). Stored raw —
 * normalizeSubject() in @bulletinmail/mime handles prefix + marker cleanup
 * at build time, identically to a mailed reply.
 */
export function replySubjectFor(rootSubject: string): string {
  const s = rootSubject.trim();
  return /^re(\s*\[\s*\d+\s*\])?\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Normalize a submitted body: CRLF → LF, strip trailing whitespace-only tail. */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** Validation for the reply form. Returns human-readable errors (empty = ok). */
export function validateReplyInput(body: string): string[] {
  const errors: string[] = [];
  if (body.trim() === "") errors.push("Write something before sending.");
  if (body.length > MAX_BODY_CHARS) {
    errors.push(`Please keep your post under ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`);
  }
  return errors;
}

/** Validation for the new-thread form. */
export function validateNewThreadInput(subject: string, body: string): string[] {
  const errors: string[] = [];
  if (subject.trim() === "") errors.push("Give your thread a subject.");
  if (subject.length > MAX_SUBJECT_CHARS) {
    errors.push(`Please keep the subject under ${MAX_SUBJECT_CHARS} characters.`);
  }
  errors.push(...validateReplyInput(body));
  return errors;
}

// ---- fan-out ----------------------------------------------------------------

/** Cloudflare's `env.EMAIL.send` returns { messageId } per the Email Service docs. */
interface SendEmailResponse {
  messageId?: string;
}

export type FanOutInput = {
  db: D1Database;
  email: SendEmail;
  config: InstanceConfig;
  tenant: Tenant;
  group: Group;
  messageId: string;
};

/**
 * Deliver an accepted web post to every active member. Mirrors the two
 * halves of the email pipeline in sequence:
 *   - workers/inbound step 8+: insert delivery rows, mark message 'queued'
 *   - workers/sender processSendJob(): unsub token → buildOutbound →
 *     assertOutboundValid → EMAIL.send → record delivery, mark 'sent'
 *
 * Designed to run inside c.executionCtx.waitUntil() after the 303 redirect.
 * The message row already exists, so the archive shows the post immediately
 * regardless of how far delivery has progressed.
 */
export async function fanOutWebPost(input: FanOutInput): Promise<void> {
  const { db, config, tenant, group } = input;
  const message = await getMessageById(db, input.messageId);
  if (!message) return;

  // Standard listserv behavior (same as inbound): the poster gets a copy too,
  // unless their delivery_mode is 'paused'.
  const members = await listActiveMembers(db, group.id);
  for (const member of members) {
    await insertDelivery(db, { messageId: message.id, memberId: member.id, status: "queued" });
  }
  await updateMessageStatus(db, message.id, "queued");

  const referencesChain = message.in_reply_to_outbound
    ? await buildReferencesChain(db, message.in_reply_to_outbound)
    : [];

  // Same signing-domain set the sender Worker allows.
  const allowedSigningDomains = [config.apexDomain];
  if (config.mailSubdomain) {
    allowedSigningDomains.push(`${config.mailSubdomain}.${config.apexDomain}`);
  }
  if (tenant.byo_domain) allowedSigningDomains.push(tenant.byo_domain);

  let anySent = false;
  for (const member of members) {
    try {
      const unsubToken = await getOrCreateUnsubToken(db, member.id);
      const built = buildOutbound({
        config,
        group,
        message,
        recipient: member,
        unsubscribeToken: unsubToken,
        tenantSlug: tenant.slug,
        referencesChain,
      });
      assertOutboundValid(built, allowedSigningDomains);
      const response = (await input.email.send(
        built.payload as unknown as Parameters<SendEmail["send"]>[0],
      )) as SendEmailResponse | undefined;
      await updateDeliverySent(
        db,
        message.id,
        member.id,
        response?.messageId ?? built.outboundMessageId,
        Date.now(),
      );
      anySent = true;
    } catch (err) {
      const reason =
        err instanceof OutboundAssertionFailure ? `assertion: ${err.message}` : String(err);
      console.error("web post delivery failed", { messageId: message.id, memberId: member.id }, err);
      await updateDeliveryFailed(db, message.id, member.id, reason, Date.now());
    }
  }

  // Converges on 'sent' exactly like the sender Worker's per-recipient jobs.
  if (anySent) {
    await updateMessageStatus(db, message.id, "sent", Date.now());
  }
}
