/**
 * Six-digit sign-in code normalization.
 *
 * The magic-link email formats the code as "123 456" for readability, so a
 * copy/paste carries the middle space — and copies from the plain-text body
 * can carry the leading indent too. Users also retype codes with dashes or
 * NBSP from HTML-email rendering. Normalization is therefore: strip every
 * non-digit (spaces of any kind, dashes, stray punctuation) and let the
 * caller validate the remainder against /^\d{6}$/.
 *
 * Shared by every verify surface — the admin SPA form, the tenant
 * sign-in-sent form, and all server-side verify handlers — so a paste that
 * passes one surface can never fail another.
 */
export function normalizeSixDigitCode(raw: string): string {
  return raw.replace(/\D/g, "");
}
