/**
 * Member sessions for the tenant archive — <tenant>.<apex>/archive.
 *
 * Members (list subscribers) are not admins: they hold `members` rows, one
 * per group, all sharing an email. This module gives that email a web
 * identity using the SAME magic-link mechanics as the admin flows (random
 * token + optional 6-digit code, 15-minute expiry, atomic consume) — no new
 * auth system, no passwords (PRD §12 #6).
 *
 * Cookie:
 *   name    : bm_member_session (separate jar from bm_tenant_session so a
 *             moderator who is also a subscriber never has one sign-in
 *             clobber the other)
 *   payload : { email, tenantId, exp }  (HMAC-SHA-256 over JSON)
 *   scope   : current host only — host-isolated like the admin cookies.
 *
 * Flow (shared with the moderator sign-in at /auth/sign-in):
 *   POST /auth/request       admin match → admin magic link (existing);
 *                            else active-member match → member magic link
 *   GET  /auth/verify?token= admin consume first, then member consume
 *   POST /auth/verify-code   { email, code } form — admin first, then member
 *
 * Verification always re-checks that the email is STILL an active member of
 * the tenant at session-use time, so an unsubscribed member's cookie stops
 * working without a revocation list.
 */

import {
  createMemberMagicLink,
  listMemberGroupIds,
  type Tenant,
} from "@bulletinmail/db";
import { systemAddress, type InstanceConfig } from "@bulletinmail/shared";

export const MEMBER_COOKIE_NAME = "bm_member_session";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export type MemberSessionPayload = {
  email: string;
  tenantId: string;
  exp: number;
};

export async function issueMemberSessionCookie(
  email: string,
  tenantId: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const payload: MemberSessionPayload = {
    email: email.toLowerCase(),
    tenantId,
    exp: now + SESSION_LIFETIME_MS,
  };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export async function verifyMemberSessionCookie(
  value: string,
  secret: string,
  now: number = Date.now(),
): Promise<MemberSessionPayload | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];
  const sig = b64urlDecode(sigB64);
  const expected = await hmacSign(secret, payloadB64);
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: MemberSessionPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as MemberSessionPayload;
  } catch { return null; }
  if (
    typeof payload.email !== "string" ||
    typeof payload.tenantId !== "string" ||
    typeof payload.exp !== "number"
  ) return null;
  if (payload.exp <= now) return null;
  return payload;
}

export function buildMemberSetCookie(value: string): string {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000);
  return `${MEMBER_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function buildMemberClearCookie(): string {
  return `${MEMBER_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readMemberCookieFromHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === MEMBER_COOKIE_NAME) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Resolve the signed-in member for this tenant, if any. Returns the email
 * plus the group ids the member may browse. Null when there is no valid
 * member session OR the email is no longer an active member of any group in
 * the tenant (unsubscribe revokes archive access on next request).
 */
export async function resolveMemberContext(opts: {
  db: D1Database;
  cookieHeader: string | null | undefined;
  tenant: Tenant;
  secret: string;
}): Promise<{ email: string; groupIds: string[] } | null> {
  const cookieValue = readMemberCookieFromHeader(opts.cookieHeader);
  if (!cookieValue) return null;
  const payload = await verifyMemberSessionCookie(cookieValue, opts.secret);
  if (!payload) return null;
  if (payload.tenantId !== opts.tenant.id) return null;

  const groupIds = await listMemberGroupIds(opts.db, opts.tenant.id, payload.email);
  if (groupIds.length === 0) return null;
  return { email: payload.email, groupIds };
}

// ---- magic-link send --------------------------------------------------------

export type SendMemberMagicLinkInput = {
  db: D1Database;
  email: SendEmail;
  config: InstanceConfig;
  tenant: Tenant;
  tenantHost: string;
  memberEmail: string;
  /** Six-digit paste-able code to include alongside the link. */
  code: string;
  /** Formatted variant of `code` for display (e.g. "123 456"). */
  formattedCode: string;
  /** Path to land on after verify (validated by the verify handler). */
  returnTo?: string | null;
};

/**
 * Send an archive sign-in email if `memberEmail` is an active member of any
 * group in the tenant. Silent no-op otherwise — never reveals whether an
 * email is subscribed (same posture as the admin flows).
 */
export async function sendMemberMagicLink(input: SendMemberMagicLinkInput): Promise<void> {
  const groupIds = await listMemberGroupIds(input.db, input.tenant.id, input.memberEmail);
  if (groupIds.length === 0) return;

  const token = randomToken();
  const expiresAt = Date.now() + MAGIC_LINK_LIFETIME_MS;
  await createMemberMagicLink(
    input.db, token, input.tenant.id, input.memberEmail, expiresAt, input.code,
  );

  const rt = input.returnTo && input.returnTo.startsWith("/")
    ? `&rt=${encodeURIComponent(input.returnTo)}`
    : "";
  const verifyUrl = `https://${input.tenantHost}/auth/verify?token=${token}${rt}`;
  const from = systemAddress(input.config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const subject = `Sign in to the ${input.tenant.display_name} archive`;
  const text = [
    `Click the link below to sign in and browse the ${input.tenant.display_name} list archive:`,
    "",
    verifyUrl,
    "",
    "Or paste this 6-digit code into the sign-in page:",
    "",
    `    ${input.formattedCode}`,
    "",
    "Link and code expire in 15 minutes and can only be used once.",
    "If you didn't request this, ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.2rem">Sign in to the ${esc(input.tenant.display_name)} archive</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="margin-top:1.5rem">Or paste this 6-digit code into the sign-in page:</p>
<p style="margin:0.5rem 0"><code style="display:inline-block;padding:0.5rem 0.9rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;font:600 1.1rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.08em">${esc(input.formattedCode)}</code></p>
<p style="color:#666;font-size:0.875rem">Link and code expire in 15 minutes and can only be used once.</p>
</body></html>`;
  try {
    await input.email.send({
      to: input.memberEmail,
      from,
      subject,
      text,
      html,
      headers: { "X-Bulletin-Purpose": "member-magic-link" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("member magic-link send failed", err);
  }
}

// ---- crypto + b64url helpers (same small set the other session modules
// carry — deliberately duplicated, see wiki/tenant-auth.ts) ------------------

function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
