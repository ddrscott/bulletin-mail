/**
 * Threading: parent resolution + References chain construction.
 *
 * Manual cross-client verification (Gmail web, Apple Mail, Outlook desktop,
 * Outlook web, Thunderbird) is required before Phase 1 acceptance — see
 * PRD §9.2.
 *
 * Two functions:
 *   - resolveParent(): called by the inbound worker on every received message.
 *     Walks the In-Reply-To + References headers and matches against our
 *     stored messages (both our outbound ids and the original Message-IDs
 *     we recorded). Returns the parent Message row or null.
 *
 *   - buildReferencesChain(): called by the sender when building outbound
 *     MIME for a reply. Walks the in_reply_to_outbound parent pointer up to
 *     MAX_REFERENCES hops; returns the ordered list of ancestor ids
 *     (root-first) for the References header.
 */

import type { Message } from "@bulletinmail/db";

export const MAX_REFERENCES = 20;

export type ResolveParentArgs = {
  inReplyTo: string | null;       // sender's In-Reply-To (brackets stripped)
  references: readonly string[];  // sender's References (brackets stripped)
};

type DbForResolve = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
};

/**
 * Strip the `@domain` part of a Message-ID-style token. Our outbound ids are
 * raw 26-char ulids stored in messages.id; the form in headers is
 * `<ulid@tenant.apex>`. Brackets are already stripped by parse.ts, so callers
 * hand us `ulid@tenant.apex`.
 */
function extractLocalPart(id: string): string {
  const at = id.indexOf("@");
  return at < 0 ? id : id.slice(0, at);
}

export async function resolveParent(
  db: DbForResolve,
  args: ResolveParentArgs,
): Promise<Message | null> {
  // Candidates in priority order: In-Reply-To first (most specific), then
  // References scanned from most recent to root.
  const candidates: string[] = [];
  if (args.inReplyTo) candidates.push(args.inReplyTo);
  for (let i = args.references.length - 1; i >= 0; i--) {
    const ref = args.references[i];
    if (ref && ref !== args.inReplyTo) candidates.push(ref);
  }

  if (candidates.length === 0) return null;

  const messageCols =
    "id, group_id, original_message_id, in_reply_to_outbound, " +
    "thread_id, from_email, from_name, subject, body_text, body_html, " +
    "has_attachments, status, rejection_reason, received_at, sent_at";

  for (const candidate of candidates) {
    // 1. Try matching as one of our outbound message ids (legacy / future:
    //    only useful when we control the Message-ID — Cloudflare Email
    //    Service doesn't currently let us).
    const local = extractLocalPart(candidate);
    const ourMatch = await db
      .prepare(`SELECT ${messageCols} FROM messages WHERE id = ?`)
      .bind(local)
      .first<Message>();
    if (ourMatch) return ourMatch;

    // 2. Try matching the sender's original Message-ID (recorded on inbound).
    //    Catches the case where someone replies to a message we *received* and
    //    archived but never re-sent.
    const senderMatch = await db
      .prepare(`SELECT ${messageCols} FROM messages WHERE original_message_id = ?`)
      .bind(candidate)
      .first<Message>();
    if (senderMatch) return senderMatch;

    // 3. Try matching Cloudflare's per-recipient outbound id. This is the
    //    common path for replies-to-our-sends: the mail client's
    //    In-Reply-To references the Message-ID Cloudflare assigned to that
    //    recipient's specific copy, which we recorded in
    //    deliveries.provider_message_id when env.EMAIL.send returned.
    //    Provider ids are stored with surrounding angle brackets; the
    //    incoming candidate has them stripped — so we check both forms.
    const providerMatch = await db
      .prepare(
        "SELECT m.id, m.group_id, m.original_message_id, m.in_reply_to_outbound, " +
          "m.thread_id, m.from_email, m.from_name, m.subject, m.body_text, m.body_html, " +
          "m.has_attachments, m.status, m.rejection_reason, m.received_at, m.sent_at " +
          "FROM messages m JOIN deliveries d ON d.message_id = m.id " +
          "WHERE d.provider_message_id = ? OR d.provider_message_id = ? LIMIT 1",
      )
      .bind(candidate, `<${candidate}>`)
      .first<Message>();
    if (providerMatch) return providerMatch;
  }

  return null;
}

type DbForChain = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
};

/**
 * Walk in_reply_to_outbound from `seedMessageId` (typically the parent of the
 * new outbound) upward through ancestors. Returns ids in root-first order,
 * including the seed itself at the end, capped at MAX_REFERENCES.
 *
 * When the chain exceeds the cap we keep the most recent ancestors — losing
 * the root is acceptable for very long threads; losing recent context is not.
 */
export async function buildReferencesChain(
  db: DbForChain,
  seedMessageId: string,
): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = seedMessageId;

  while (current !== null && chain.length < MAX_REFERENCES + 5) {
    chain.unshift(current);
    const row: { in_reply_to_outbound: string | null } | null = await db
      .prepare("SELECT in_reply_to_outbound FROM messages WHERE id = ?")
      .bind(current)
      .first<{ in_reply_to_outbound: string | null }>();
    if (!row) break;
    current = row.in_reply_to_outbound;
  }

  return chain.length > MAX_REFERENCES ? chain.slice(-MAX_REFERENCES) : chain;
}
