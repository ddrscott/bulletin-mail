/**
 * Sender Worker — Cloudflare Queue consumer.
 *
 * For each {messageId, memberId} job:
 *   1. Load message + member + group + tenant.
 *   2. Skip suppressed (non-active) members → mark delivery 'suppressed'.
 *   3. Hard-stop on `held_moderation` (PRD §12 invariant #4).
 *   4. Build outbound MIME via @bulletinmail/mime/build.
 *   5. assertOutboundValid() — fires before any send.
 *   6. env.EMAIL.send(payload) → returns { messageId }.
 *   7. Record delivery (status, provider_message_id, delivered_at).
 *   8. Mark the parent message 'sent' (idempotent; last write wins).
 *
 * Failures: per-job try/catch. Non-retryable errors (member missing, message
 * missing, assertion failure) ack the job to avoid infinite retry. Retryable
 * errors (transient API failure) call .retry() and rely on Queue redrive.
 *
 * See PRD §8.2.
 */

import { loadFromEnv, type InstanceConfig } from "@bulletinmail/shared";
import {
  getGroupById,
  getMemberById,
  getMessageById,
  getOrCreateUnsubToken,
  getTenantById,
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

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  EMAIL: SendEmail;
  [varName: string]: unknown;
}

export type SendJob = {
  messageId: string;
  memberId: string;
};

/** Cloudflare's `env.EMAIL.send` returns { messageId } per the Email Service docs. */
interface SendEmailResponse {
  messageId?: string;
}

export default {
  async queue(
    batch: MessageBatch<SendJob>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const config = loadFromEnv(env as unknown as Record<string, unknown>);

    for (const msg of batch.messages) {
      try {
        await processSendJob(env, config, msg.body);
        msg.ack();
      } catch (err) {
        if (err instanceof PermanentSendError) {
          // Don't retry — bad job, would just loop. Record and move on.
          console.error("permanent send failure", msg.body, err.message);
          await updateDeliveryFailed(
            env.DB,
            msg.body.messageId,
            msg.body.memberId,
            err.message,
            Date.now(),
          );
          msg.ack();
        } else {
          // Transient — let the queue retry.
          console.error("transient send failure", msg.body, err);
          msg.retry();
        }
      }
    }
  },
};

class PermanentSendError extends Error {}

async function processSendJob(env: Env, config: InstanceConfig, job: SendJob): Promise<void> {
  const message = await getMessageById(env.DB, job.messageId);
  if (!message) throw new PermanentSendError(`Message not found: ${job.messageId}`);
  if (message.status === "held_moderation") {
    throw new PermanentSendError("Refusing to auto-send a held_moderation message (PRD §12 #4)");
  }
  if (message.status === "rejected") {
    throw new PermanentSendError("Message is in rejected status");
  }

  const member = await getMemberById(env.DB, job.memberId);
  if (!member) throw new PermanentSendError(`Member not found: ${job.memberId}`);
  if (member.status !== "active") {
    // Member was unsubscribed or bouncing AFTER the job was enqueued.
    await updateDeliveryFailed(
      env.DB,
      message.id,
      member.id,
      `suppressed (member.status=${member.status})`,
      Date.now(),
    );
    // Not a "real" failure — ack via the outer handler.
    throw new PermanentSendError(`Member status ${member.status}; skipping`);
  }

  const group = await getGroupById(env.DB, message.group_id);
  if (!group) throw new PermanentSendError(`Group not found: ${message.group_id}`);
  const tenant = await getTenantById(env.DB, group.tenant_id);
  if (!tenant) throw new PermanentSendError(`Tenant not found: ${group.tenant_id}`);
  if (tenant.status !== "active") {
    throw new PermanentSendError(`Tenant ${tenant.slug} is ${tenant.status}`);
  }

  // Mint or fetch a stable unsub token for this member.
  const unsubToken = await getOrCreateUnsubToken(env.DB, member.id);

  // Walk the parent chain for the References header (capped in mime/threading).
  const referencesChain = message.in_reply_to_outbound
    ? await buildReferencesChain(env.DB, message.in_reply_to_outbound)
    : [];

  // Build the outbound payload — pure function, no I/O.
  const built = buildOutbound({
    config,
    group,
    message,
    recipient: member,
    unsubscribeToken: unsubToken,
    tenantSlug: tenant.slug,
    referencesChain,
  });

  // Domains we DKIM-sign for. For a BYO-domain tenant, accept their domain
  // too (V4 unblocked); otherwise the apex is the only valid signer.
  const allowedSigningDomains = [config.apexDomain];
  if (tenant.byo_domain) allowedSigningDomains.push(tenant.byo_domain);

  try {
    assertOutboundValid(built, allowedSigningDomains);
  } catch (err) {
    if (err instanceof OutboundAssertionFailure) {
      throw new PermanentSendError(`assertion: ${err.message}`);
    }
    throw err;
  }

  // Send. Modern Email Service binding API.
  const response = (await env.EMAIL.send(built.payload as unknown as Parameters<SendEmail["send"]>[0])) as
    | SendEmailResponse
    | undefined;
  const providerMessageId = response?.messageId ?? built.outboundMessageId;

  await updateDeliverySent(env.DB, message.id, member.id, providerMessageId, Date.now());

  // Mark the parent message 'sent'. Idempotent — every successful per-recipient
  // send may rewrite this, but they all converge on 'sent'.
  if (message.status !== "sent") {
    await updateMessageStatus(env.DB, message.id, "sent", Date.now());
  }
}
