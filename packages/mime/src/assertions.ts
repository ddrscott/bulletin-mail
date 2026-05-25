/**
 * Runtime invariants enforced on every outbound message — the cross-phase
 * invariants from PRD §12. Called immediately before env.EMAIL.send.
 *
 * Never disable. If an assertion fires in production, fix the upstream code
 * path rather than relaxing the assertion.
 */

import type { BuiltOutbound } from "./build.js";

export class OutboundAssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundAssertionFailure";
  }
}

const ADDR_RE = /<([^>@\s]+@([^>\s]+))>/;

/**
 * Asserts:
 *   1. From-header domain is one we DKIM-sign for (apex or a BYO-domain).
 *      DMARC alignment depends on this — PRD §12 invariant #1.
 *   2. List-Unsubscribe header present (both mailto and https forms).
 *      PRD §12 invariant #2.
 *   3. List-Unsubscribe-Post present with the One-Click value.
 *   4. Subject is non-empty.
 *   5. Single recipient (per-member fan-out, never multi-To).
 *
 * Message-ID is intentionally NOT asserted: Cloudflare Email Service treats
 * it as platform-controlled and assigns its own. We capture the assigned id
 * from the send response into deliveries.provider_message_id.
 */
export function assertOutboundValid(
  built: BuiltOutbound,
  allowedSigningDomains: readonly string[],
): void {
  const { payload, fromDomain } = built;

  // 1. From-domain authority.
  const fromMatch = ADDR_RE.exec(payload.from);
  if (!fromMatch) {
    throw new OutboundAssertionFailure(
      `From header missing or unparseable: ${payload.from}`,
    );
  }
  const actualFromDomain = fromMatch[2]!.toLowerCase();
  if (!domainMatches(actualFromDomain, allowedSigningDomains)) {
    throw new OutboundAssertionFailure(
      `From domain '${actualFromDomain}' not in allowed signing domains: ${allowedSigningDomains.join(", ")}`,
    );
  }
  if (actualFromDomain !== fromDomain.toLowerCase()) {
    throw new OutboundAssertionFailure(
      `From domain in header (${actualFromDomain}) does not match resolved fromDomain (${fromDomain})`,
    );
  }

  // 2. List-Unsubscribe — must contain both <mailto:...> and <https://...>.
  const unsub = payload.headers["List-Unsubscribe"];
  if (!unsub) {
    throw new OutboundAssertionFailure("List-Unsubscribe header is missing");
  }
  if (!/^<mailto:/i.test(unsub.trim())) {
    throw new OutboundAssertionFailure(
      "List-Unsubscribe must start with a <mailto:...> form (some clients only honor the first)",
    );
  }
  if (!/<https:/i.test(unsub)) {
    throw new OutboundAssertionFailure(
      "List-Unsubscribe must include a <https://...> form for RFC 8058 one-click",
    );
  }

  // 3. List-Unsubscribe-Post.
  const unsubPost = payload.headers["List-Unsubscribe-Post"];
  if (!unsubPost || !/List-Unsubscribe=One-Click/i.test(unsubPost)) {
    throw new OutboundAssertionFailure(
      "List-Unsubscribe-Post must be 'List-Unsubscribe=One-Click' for Gmail/Yahoo one-click compliance",
    );
  }

  // 4. Subject non-empty.
  if (!payload.subject || payload.subject.trim().length === 0) {
    throw new OutboundAssertionFailure("Subject is empty");
  }

  // 5. Single recipient.
  if (Array.isArray(payload.to)) {
    throw new OutboundAssertionFailure(
      "Outbound must have a single recipient (per-member fan-out, never an array)",
    );
  }
}

function domainMatches(actual: string, allowed: readonly string[]): boolean {
  const a = actual.toLowerCase();
  for (const dom of allowed) {
    const d = dom.toLowerCase();
    if (a === d) return true;
    if (a.endsWith("." + d)) return true; // subdomain of an allowed apex
  }
  return false;
}
