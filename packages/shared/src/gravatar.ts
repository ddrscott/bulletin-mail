/**
 * Gravatar helpers — used by both the admin SPA (avatar URLs) and the web
 * worker (profile name lookup on member/team insert).
 *
 * The avatar URL is deterministic from `sha256(lowercased trimmed email)`,
 * so the browser can render the <img> directly without a round-trip. The
 * profile name comes from `https://gravatar.com/<hash>.json` and is best-
 * effort — if Gravatar 404s (no profile for this email) or rate-limits us,
 * the caller falls back to the email's local-part.
 */

const encoder = new TextEncoder();

export async function gravatarHash(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalized));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Avatar URL for an email. `d=identicon` ensures a per-hash fallback so even
 * users without a Gravatar account get a stable, visually-distinct shape.
 * `s` is pixel size of the longest edge (Gravatar serves square).
 */
export async function gravatarAvatarUrl(email: string, size = 64): Promise<string> {
  const hash = await gravatarHash(email);
  return `https://gravatar.com/avatar/${hash}?d=identicon&s=${size}`;
}

/**
 * Server-side: hit the unauthenticated Gravatar profile endpoint and return
 * a best-effort display name. Returns null if no profile is registered for
 * this email or the fetch fails for any reason. Never throws.
 *
 * Response shape (legacy public endpoint): `{ entry: [{ displayName, name:
 * { givenName, familyName, formatted }, preferredUsername, ... }] }`.
 */
export async function fetchGravatarDisplayName(email: string): Promise<string | null> {
  try {
    const hash = await gravatarHash(email);
    const res = await fetch(`https://gravatar.com/${hash}.json`, {
      cf: { cacheTtl: 3600 } as RequestInitCfPropertiesRecord,
      headers: { "User-Agent": "BulletinMail/0.1 (+https://bulletinmail.org)" },
    } as RequestInit);
    if (!res.ok) return null; // 404 = no profile registered
    const data = (await res.json()) as GravatarProfileResponse;
    const entry = data.entry?.[0];
    if (!entry) return null;
    if (entry.name?.formatted) return entry.name.formatted.trim() || null;
    const given = entry.name?.givenName?.trim();
    const family = entry.name?.familyName?.trim();
    if (given || family) return [given, family].filter(Boolean).join(" ");
    if (entry.displayName) return entry.displayName.trim() || null;
    return null;
  } catch {
    return null;
  }
}

type GravatarProfileResponse = {
  entry?: Array<{
    displayName?: string;
    preferredUsername?: string;
    name?: {
      givenName?: string;
      familyName?: string;
      formatted?: string;
    };
  }>;
};

// Lightweight CF-specific Request type (avoids importing @cloudflare/workers-types).
type RequestInitCfPropertiesRecord = { cacheTtl?: number };
