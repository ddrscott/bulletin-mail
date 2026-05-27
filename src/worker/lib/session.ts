/**
 * Admin session cookie — HMAC-SHA-256 signed payload.
 *
 * Format:  `<base64url(payload_json)>.<base64url(hmac)>`
 * Payload: `{ adminId: string, exp: number }` (exp is unix ms)
 *
 * Signed with `ADMIN_API_JWT_SECRET`. We don't use full JWT — there's exactly
 * one issuer (this Worker) and one verifier (this Worker), so the JWS algo
 * field would only invite downgrade attacks. A constant HMAC + JSON payload
 * is enough.
 *
 * Cookie attributes (set in routes/admin/auth.ts):
 *   - HttpOnly, Secure, SameSite=Lax (per PRD §11 Phase 2)
 *   - Path=/admin (admin lives at <apex>/admin post-consolidation;
 *     scoping Path keeps the cookie off marketing/docs requests)
 *   - Max-Age=7d to match payload `exp`
 */

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type SessionPayload = {
  adminId: string;
  exp: number;
};

export const SESSION_COOKIE_NAME = "bm_admin_session";

export async function issueSessionCookie(
  adminId: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const payload: SessionPayload = { adminId, exp: now + SESSION_LIFETIME_MS };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Verify a session cookie value. Returns the payload on success, null on any
 * failure (bad signature, malformed, expired). Constant-time signature check
 * via `crypto.subtle.verify` per Web Crypto.
 */
export async function verifySessionCookie(
  value: string,
  secret: string,
  now: number = Date.now(),
): Promise<SessionPayload | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];

  const sig = b64urlDecode(sigB64);
  const expected = await hmacSign(secret, payloadB64);
  if (!constantTimeEqual(sig, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.adminId !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now) return null;
  return payload;
}

/** Build the Set-Cookie header value. Path=/admin scopes the cookie to the
 * admin SPA only — apex marketing/docs requests don't get the auth cookie. */
export function buildSessionSetCookie(value: string): string {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${maxAge}`;
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`;
}

export function readSessionCookieFromHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === SESSION_COOKIE_NAME) return part.slice(eq + 1);
  }
  return null;
}

// ---- HMAC + base64url helpers -----------------------------------------------

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
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
