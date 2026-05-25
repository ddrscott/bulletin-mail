/**
 * Magic-link generation + email rendering.
 *
 * Sign-in flow (PRD §10):
 *   1. POST /api/auth/request {email} → look up admins by email.
 *   2. For each match, create a magic_links row with a fresh opaque token
 *      and a 15-min expiry. Send one email per tenant via env.EMAIL.
 *   3. User clicks the link → /auth/verify?token=… → /api/auth/verify
 *      consumes the token atomically, issues a session cookie, redirects to /.
 *
 * Why per-tenant magic links: the admins table is (tenant_id, email) UNIQUE,
 * so the same human email can be an admin for multiple tenants. Each token
 * is scoped to one admin row; we issue one per match so the user picks the
 * tenant by which email link they open.
 */

import type { InstanceConfig } from "@bulletinmail/shared";
import { systemAddress } from "@bulletinmail/shared";

export const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

/** 32 random bytes → 64-char hex string. */
export function generateMagicLinkToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
}

export type MagicLinkEmail = {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

/**
 * Render the transactional magic-link email. Sent from noreply@<apex>.
 * Includes the tenant display name in the subject + body so a user with
 * multi-tenant access can distinguish which tenant the link is for.
 */
export function renderMagicLinkEmail(input: {
  config: InstanceConfig;
  recipientEmail: string;
  tenantDisplayName: string;
  verifyUrl: string;
}): MagicLinkEmail {
  const { config, recipientEmail, tenantDisplayName, verifyUrl } = input;
  const from = systemAddress(config, "noreply");
  const subject = `Sign in to ${config.productName} — ${tenantDisplayName}`;
  const text = [
    `Click the link below to sign in to ${config.productName} as an admin for ${tenantDisplayName}:`,
    "",
    verifyUrl,
    "",
    "This link expires in 15 minutes and can only be used once.",
    "",
    "If you didn't request this, you can safely ignore this email.",
    "",
    `— ${config.productName}`,
  ].join("\n");
  const html =
    `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">` +
    `<h1 style="font-size:1.25rem">Sign in to ${esc(config.productName)}</h1>` +
    `<p>Click below to sign in as an admin for <strong>${esc(tenantDisplayName)}</strong>:</p>` +
    `<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>` +
    `<p style="color:#666;font-size:0.875rem">Or paste this URL into your browser:<br><code style="word-break:break-all">${esc(verifyUrl)}</code></p>` +
    `<p style="color:#666;font-size:0.875rem">This link expires in 15 minutes and can only be used once. If you didn't request this, ignore this email.</p>` +
    `</body></html>`;
  return {
    to: recipientEmail,
    from,
    subject,
    text,
    html,
    headers: {
      "X-Bulletin-Purpose": "magic-link",
    },
  };
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
