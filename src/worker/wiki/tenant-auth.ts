/**
 * Tenant-scoped admin auth. Separate from the apex admin session so cookies
 * stay host-isolated — per Scott's call, "apex admin shouldn't have editor
 * rights. tenant moderators do."
 *
 * Cookie:
 *   name : bm_tenant_session
 *   payload : { adminId, tenantId, exp }  (HMAC-SHA-256 over JSON)
 *   scope : current host only (no Domain attribute) — does NOT cross
 *           subdomains, so app.<apex>'s cookie and <tenant>.<apex>'s cookie
 *           live in independent jars.
 *
 * Magic-link flow:
 *   GET  /auth/sign-in            email form (server-rendered)
 *   POST /auth/request            { email } → look up tenant admin → send
 *                                    a magic link whose verify URL is on
 *                                    THIS tenant subdomain
 *   GET  /auth/verify?token=...   consume token → set cookie → redirect /
 *   POST /auth/sign-out           clear cookie
 *
 * Token verification additionally checks that admin.tenant_id matches the
 * tenant we resolved from the host — so a tenant-A admin can't sign in on
 * tenant-B's subdomain even if they hold a token, and even if cookies leaked.
 */

import {
  consumeMagicLink,
  createMagicLink,
  getAdminById,
  getAdminsByEmail,
  getTenantBySlug,
  type Admin,
  type Tenant,
} from "@bulletinmail/db";
import { systemAddress, type InstanceConfig } from "@bulletinmail/shared";

export const TENANT_COOKIE_NAME = "bm_tenant_session";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export type TenantSessionPayload = {
  adminId: string;
  tenantId: string;
  exp: number;
};

export async function issueTenantSessionCookie(
  adminId: string,
  tenantId: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const payload: TenantSessionPayload = { adminId, tenantId, exp: now + SESSION_LIFETIME_MS };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export async function verifyTenantSessionCookie(
  value: string,
  secret: string,
  now: number = Date.now(),
): Promise<TenantSessionPayload | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];
  const sig = b64urlDecode(sigB64);
  const expected = await hmacSign(secret, payloadB64);
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: TenantSessionPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as TenantSessionPayload;
  } catch { return null; }
  if (typeof payload.adminId !== "string" || typeof payload.tenantId !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now) return null;
  return payload;
}

export function buildTenantSetCookie(value: string): string {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000);
  return `${TENANT_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function buildTenantClearCookie(): string {
  return `${TENANT_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readTenantCookieFromHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === TENANT_COOKIE_NAME) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Resolve the current request's tenant + signed-in admin.
 *
 * Returns:
 *   - tenant   : non-null if the host's slug matches an active tenant
 *   - admin    : non-null if the cookie verifies AND admin.tenant_id === tenant.id
 *
 * Routes that need editor rights should check `admin !== null`.
 */
export async function resolveTenantContext(opts: {
  db: D1Database;
  cookieHeader: string | null | undefined;
  tenantSlug: string;
  secret: string;
}): Promise<{ tenant: Tenant | null; admin: Admin | null }> {
  const tenant = await getTenantBySlug(opts.db, opts.tenantSlug);
  if (!tenant || tenant.status !== "active") return { tenant: null, admin: null };

  const cookieValue = readTenantCookieFromHeader(opts.cookieHeader);
  if (!cookieValue) return { tenant, admin: null };
  const payload = await verifyTenantSessionCookie(cookieValue, opts.secret);
  if (!payload) return { tenant, admin: null };
  if (payload.tenantId !== tenant.id) return { tenant, admin: null };

  const admin = await getAdminById(opts.db, payload.adminId);
  if (!admin || admin.tenant_id !== tenant.id) return { tenant, admin: null };
  return { tenant, admin };
}

// ---- magic-link request / verify --------------------------------------------

export type SendTenantMagicLinkInput = {
  db: D1Database;
  email: SendEmail;
  config: InstanceConfig;
  tenant: Tenant;
  tenantHost: string;
  email_: string;
};

/**
 * Send the magic-link email scoped to this tenant. Looks up admins for the
 * email; only sends if one matches THIS tenant. Always returns void; never
 * reveals whether the email matched.
 */
export async function sendTenantMagicLink(input: SendTenantMagicLinkInput): Promise<void> {
  const admins = await getAdminsByEmail(input.db, input.email_);
  const target = admins.find((a) => a.tenant_id === input.tenant.id);
  if (!target) return;

  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let token = "";
  for (let i = 0; i < buf.length; i++) token += buf[i]!.toString(16).padStart(2, "0");

  const expiresAt = Date.now() + MAGIC_LINK_LIFETIME_MS;
  await createMagicLink(input.db, token, target.id, expiresAt);

  const verifyUrl = `https://${input.tenantHost}/auth/verify?token=${token}`;
  const from = systemAddress(input.config, "noreply");
  const subject = `Sign in to ${input.tenant.display_name}`;
  const text = [
    `Click the link below to sign in to ${input.tenant.display_name} as a moderator:`,
    "",
    verifyUrl,
    "",
    "This link expires in 15 minutes and can only be used once.",
    "If you didn't request this, ignore this email.",
  ].join("\n");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const html = `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.2rem">Sign in to ${esc(input.tenant.display_name)}</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="color:#666;font-size:0.875rem">Or paste this URL into your browser:<br><code style="word-break:break-all">${esc(verifyUrl)}</code></p>
<p style="color:#666;font-size:0.875rem">This link expires in 15 minutes and can only be used once.</p>
</body></html>`;
  try {
    await input.email.send({
      to: input.email_,
      from,
      subject,
      text,
      html,
      headers: { "X-Bulletin-Purpose": "tenant-magic-link" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("tenant magic-link send failed", err);
  }
}

/** Consume a token; succeed only if the resulting admin belongs to this tenant. */
export async function consumeTenantMagicLink(
  db: D1Database,
  token: string,
  tenant: Tenant,
): Promise<Admin | null> {
  const admin = await consumeMagicLink(db, token, Date.now());
  if (!admin) return null;
  if (admin.tenant_id !== tenant.id) return null;
  return admin;
}

// ---- crypto + b64url helpers (duplicated from lib/session.ts — small) -----

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

export { MAGIC_LINK_LIFETIME_MS };
