/**
 * Cloudflare Turnstile verification — bot protection for admin sign-in,
 * the archive post forms, and the apex /contact form.
 *
 * Env-gated, not feature-flagged. Pattern from auth.ljs.app:
 *   - If TURNSTILE_SECRET_KEY is unset → bypass (returns true). Dev mode
 *     without Turnstile configured.
 *   - If set + token missing → false. Reject the request.
 *   - If set + token present → POST to challenges.cloudflare.com/.../siteverify
 *     with optional remoteip. Trust whatever Cloudflare says.
 *
 * The site key is public; the secret is a Worker secret. The bound names
 * on env are deliberately TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY (not
 * INSTANCE_* prefixed) so they don't leak into the InstanceConfig payload
 * that gets parsed on every request — these aren't per-deployment branding,
 * they're infrastructure credentials.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    // Network blip → treat as failure. The user can retry; we don't want to
    // silently bypass the check because Cloudflare's siteverify endpoint is
    // momentarily unreachable.
    return false;
  }
}
