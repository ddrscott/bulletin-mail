/**
 * Builds outbound MIME from a stored message + recipient + InstanceConfig.
 *
 * Uses the modern `env.EMAIL.send({to, from, subject, html, text, headers,
 * replyTo})` API. Headers produced here are non-negotiable — they directly
 * determine DMARC alignment (PRD §9.1), threading correctness (§9.2), and
 * one-click unsubscribe behavior (§9.4). Test changes against the cross-
 * client checklist in PRD §9.2 before merging.
 *
 * The From-header rewrite is the central architectural decision: the From
 * domain is ALWAYS our apex (or a BYO-domain tenant's). We always DKIM-sign
 * for that domain. SPF passes via Cloudflare's authorized IPs. DMARC aligns.
 */

import type {
  InstanceConfig,
} from "@bulletinmail/shared";
import { systemAddress, unsubscribeMailto, unsubscribeUrl, archiveUrl } from "@bulletinmail/shared";
import type { Group, Member, Message } from "@bulletinmail/db";
import { normalizeSubject } from "./subject.js";

export type OutboundBuildInput = {
  config: InstanceConfig;
  group: Group;
  message: Message;
  recipient: Member;
  unsubscribeToken: string;             // looked up by sender worker
  tenantSlug: string;                   // resolved from group.tenant_id
  referencesChain: readonly string[];   // ancestors of THIS message (our outbound ids, root-first)
};

/**
 * Shape passed to `env.EMAIL.send()`. Modeled on the modern Workers binding
 * API (PRD §17 #3, confirmed via Cloudflare docs).
 */
export type SendEmailPayload = {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
};

export type BuiltOutbound = {
  payload: SendEmailPayload;
  outboundMessageId: string;            // e.g. "abc@firstpresby.example.org" (with brackets in header)
  fromDomain: string;                   // for assertOutboundValid
};

/**
 * Build the outbound payload for a single recipient. Pure function — no I/O,
 * no env access; the sender worker passes everything in.
 */
export function buildOutbound(input: OutboundBuildInput): BuiltOutbound {
  const {
    config,
    group,
    message,
    recipient,
    unsubscribeToken,
    tenantSlug,
    referencesChain,
  } = input;

  // Inbound-facing address (what recipients type to mail the list; what
  // List-Unsubscribe-via-mailto and Reply-To point at). Lives on the tenant
  // subdomain so Email Routing's catch-all picks it up.
  const inboundGroupAddress = `${group.name}@${tenantSlug}.${config.apexDomain}`;

  // Outbound-facing From address — MUST be on the apex because Cloudflare
  // Email Service only authorizes sending from domains with Email Routing
  // enabled (PRD §17 #6 — verified empirically 2026-05-25 with the error
  // `email sending not authorized for subdomain '<slug>.<apex>'`). Sending
  // from `<slug>-<group>@<apex>` keeps DMARC alignment on the apex while
  // preserving tenant identification in the local-part for support / abuse.
  const outboundFromAddress = `${tenantSlug}-${group.name}@${config.apexDomain}`;
  const fromDomain = config.apexDomain;

  // From-header rewrite — see PRD §9.1. The display name carries the tenant
  // identity so recipients see e.g.:
  //   "Pastor John via Demo Announcements" <demo-announcements@example.org>
  // while replies land on the subdomain list address via Reply-To.
  const senderDisplay = message.from_name?.trim() || message.from_email;
  const fromHeader = formatNameAddr(
    `${senderDisplay} via ${group.display_name}`,
    outboundFromAddress,
  );

  // Reply-To policy. Default `list` → subdomain list address (inbound works).
  // `sender` → original author's address (bypasses the list, e.g. announce_only).
  const replyTo =
    group.reply_to_policy === "sender"
      ? message.from_email
      : inboundGroupAddress;

  // Subject prefix (§9.3).
  const subject = normalizeSubject({
    raw: message.subject,
    prefix: group.subject_prefix,
  });

  // Threading (§9.2). Cloudflare's Email Service is the canonical authority
  // on Message-ID for outbound mail — it's a platform-controlled header that
  // cannot be set via `headers`. Each per-recipient send returns a different
  // assigned Message-ID; we record those in deliveries.provider_message_id
  // and rely on them (not our own ids) for inbound thread reconstruction.
  //
  // Our internal `outboundMessageId` here remains a useful local identifier
  // for logging and as a fallback if the provider doesn't return one — but
  // it doesn't appear in the wire headers.
  const outboundMessageId = `${message.id}@${tenantSlug}.${config.apexDomain}`;

  // referencesChain holds our outbound message ids for ancestors INCLUDING
  // this message's parent. For In-Reply-To / References, we want the actual
  // delivery's provider_message_id of the parent message — but we don't have
  // a clean way to know "which recipient's copy" the new reply was made
  // against. For V1 we emit the original-sender Message-ID of the parent
  // (recorded as messages.original_message_id) if available, which threads
  // correctly when the recipient is replying through their mail client.
  let inReplyToHeader: string | undefined;
  let referencesHeader: string | undefined;
  if (referencesChain.length > 0) {
    // Best-effort: use our internal ids as opaque tokens. Cloudflare strips
    // anything not in the recognized format; mail clients that thread purely
    // by Subject still work. Proper threading requires storing provider IDs.
    const parent = referencesChain[referencesChain.length - 1]!;
    inReplyToHeader = `<${parent}@${tenantSlug}.${config.apexDomain}>`;
    referencesHeader = referencesChain
      .map((id) => `<${id}@${tenantSlug}.${config.apexDomain}>`)
      .join(" ");
  }

  // List-* headers — RFC 2369 + RFC 8058. Cloudflare's whitelist for the
  // Email Service `headers` field only accepts a narrow set:
  //   In-Reply-To, References, List-Unsubscribe, List-Unsubscribe-Post,
  //   plus any X-* prefixed header.
  // List-Id, List-Post, List-Archive, Precedence, Auto-Submitted are NOT
  // whitelisted by Cloudflare; they would cause E_HEADER_NOT_ALLOWED. We
  // re-emit them as X-Bulletin-* so they remain visible for archive/debug,
  // and Cloudflare may add some of these (Precedence, etc.) itself.
  const listMailto = unsubscribeMailto(config, unsubscribeToken);
  const listUrl = unsubscribeUrl(config, unsubscribeToken);
  const archive = archiveUrl(config, tenantSlug, group.name);

  const headers: Record<string, string> = {
    "List-Unsubscribe": `<mailto:${listMailto}>, <${listUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "X-Bulletin-List-Id": `<${group.name}.${tenantSlug}.${config.apexDomain}>`,
    "X-Bulletin-List-Post": `<mailto:${inboundGroupAddress}>`,
    "X-Bulletin-List-Archive": `<${archive}>`,
    "X-Original-From": message.from_email,
  };
  if (message.original_message_id) {
    headers["X-Original-Message-ID"] = `<${message.original_message_id}>`;
  }
  if (inReplyToHeader) headers["In-Reply-To"] = inReplyToHeader;
  if (referencesHeader) headers["References"] = referencesHeader;

  const payload: SendEmailPayload = {
    to: recipient.email,
    from: fromHeader,
    replyTo,
    subject,
    headers,
  };

  if (message.body_text) payload.text = message.body_text;
  if (message.body_html) payload.html = message.body_html;

  return {
    payload,
    outboundMessageId,
    fromDomain,
  };
}

/**
 * Format an RFC 5322 name-addr. Quote the display name if it contains chars
 * that would otherwise need escaping; backslash-escape internal `"` and `\`.
 */
function formatNameAddr(name: string, addr: string): string {
  const cleaned = name.trim();
  if (!cleaned) return `<${addr}>`;
  // If it contains any specials, quote it.
  if (/["(),:;<>@\[\]\\]/.test(cleaned)) {
    const escaped = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}" <${addr}>`;
  }
  return `${cleaned} <${addr}>`;
}

// Re-export so callers can import config helpers from a single place.
export { systemAddress };
