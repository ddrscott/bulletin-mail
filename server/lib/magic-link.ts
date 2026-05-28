/**
 * Magic-link generation + email rendering.
 *
 * Sign-in flow (PRD §10):
 *   1. POST /api/auth/request {email} → look up admins by email.
 *   2. For each match, create a magic_links row with a fresh opaque token,
 *      a 6-digit paste-able code, and a 15-min expiry. Send one email per
 *      tenant via env.EMAIL.
 *   3. User either:
 *      a) clicks the link → /auth/verify?token=… → consumes by token, or
 *      b) pastes the code → POST /api/auth/verify-code → consumes by code.
 *      Both paths share the same row (atomic single-use semantics).
 *
 * Why per-tenant magic links: the admins table is (tenant_id, email) UNIQUE,
 * so the same human email can be an admin for multiple tenants. Each token
 * is scoped to one admin row; we issue one per match so the user picks the
 * tenant by which email link/code they open.
 *
 * Why a 6-digit code in addition to the link:
 *   - User reads email on phone, signs in on laptop → typing 6 digits beats
 *     forwarding the link.
 *   - Corporate filters rewrite URLs (Proofpoint, Microsoft Safelinks etc.)
 *     and sometimes mangle one-time tokens. The code path bypasses that.
 *   - Pattern stolen wholesale from auth.ljs.app/src/routes/auth.ts —
 *     same crypto.getRandomValues mod-1e6, same `123 456` formatting.
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

/**
 * Generate a 6-digit numeric code via crypto.getRandomValues. Modulo bias
 * over 2**32 → 10**6 is ~6e-5 — negligible for a 15-minute one-time code
 * (an attacker would have to brute-force the code AND hit the same email
 * before expiry). Same approach as auth.ljs.app.
 */
export function generateSixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

/**
 * Format a 6-digit code for human readability: "123456" → "123 456".
 * Used in email body + as the placeholder hint in the SPA input. The
 * verify endpoint strips whitespace before lookup so users can paste
 * either form.
 */
export function formatSixDigitCode(code: string): string {
  if (!/^\d{6}$/.test(code)) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
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
 *
 * `code` is optional: the team-invite + tenant-bootstrap flows skip it
 * (the recipient didn't ask for a code-based sign-in). When present,
 * the formatted code is rendered prominently in both text and HTML
 * bodies, alongside the existing link.
 */
export function renderMagicLinkEmail(input: {
  config: InstanceConfig;
  recipientEmail: string;
  tenantDisplayName: string;
  verifyUrl: string;
  code?: string | null;
}): MagicLinkEmail {
  const { config, recipientEmail, tenantDisplayName, verifyUrl, code } = input;
  const from = systemAddress(config, "noreply");
  const subject = `Sign in to ${config.productName} — ${tenantDisplayName}`;
  const formattedCode = code ? formatSixDigitCode(code) : null;
  const textLines = [
    `Click the link below to sign in to ${config.productName} as an admin for ${tenantDisplayName}:`,
    "",
    verifyUrl,
    "",
  ];
  if (formattedCode) {
    textLines.push(
      `Or paste this 6-digit code into the sign-in page:`,
      "",
      `    ${formattedCode}`,
      "",
    );
  }
  textLines.push(
    "This link expires in 15 minutes and can only be used once.",
    "",
    "If you didn't request this, you can safely ignore this email.",
    "",
    `— ${config.productName}`,
  );
  const text = textLines.join("\n");

  const codeHtml = formattedCode
    ? `<p style="margin-top:1.5rem">Or paste this 6-digit code into the sign-in page:</p>` +
      `<p style="margin:0.5rem 0"><code style="display:inline-block;padding:0.5rem 0.9rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;font:600 1.1rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.08em">${esc(formattedCode)}</code></p>`
    : "";
  const html =
    `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">` +
    `<h1 style="font-size:1.25rem">Sign in to ${esc(config.productName)}</h1>` +
    `<p>Click below to sign in as an admin for <strong>${esc(tenantDisplayName)}</strong>:</p>` +
    `<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>` +
    `<p style="color:#666;font-size:0.875rem">Or paste this URL into your browser:<br><code style="word-break:break-all">${esc(verifyUrl)}</code></p>` +
    codeHtml +
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
