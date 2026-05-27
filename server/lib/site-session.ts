/**
 * Site-admin session cookie. Separate from the tenant-admin session
 * (`bm_tenant_session`) — site admins operate the instance (create tenants),
 * tenant admins manage one tenant. Different scope, different cookie.
 *
 * Same HMAC-SHA-256 / `<b64url(payload)>.<b64url(sig)>` shape as the older
 * tenant cookie. Cookie name + payload key are distinct so the two never
 * collide even if a site admin also happens to be a tenant admin.
 */

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type SiteSessionPayload = { siteAdminId: string; exp: number };
export const SITE_COOKIE_NAME = "bm_site_session";

export async function issueSiteSessionCookie(
  siteAdminId: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const payload: SiteSessionPayload = { siteAdminId, exp: now + SESSION_LIFETIME_MS };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export async function verifySiteSessionCookie(
  value: string,
  secret: string,
  now: number = Date.now(),
): Promise<SiteSessionPayload | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];
  const sig = b64urlDecode(sigB64);
  const expected = await hmacSign(secret, payloadB64);
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: SiteSessionPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as SiteSessionPayload;
  } catch { return null; }
  if (typeof payload.siteAdminId !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now) return null;
  return payload;
}

export function buildSiteSetCookie(value: string): string {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000);
  return `${SITE_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${maxAge}`;
}

export function buildSiteClearCookie(): string {
  return `${SITE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`;
}

export function readSiteCookieFromHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === SITE_COOKIE_NAME) return part.slice(eq + 1);
  }
  return null;
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
