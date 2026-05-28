# 6-digit code + human check on admin sign-in

## Problem

The current admin sign-in flow (`server/lib/magic-link.ts`, `server/routes/admin/auth.ts`,
`admin/views/signin.ts`) only offers a clickable magic link. Two gaps:

1. **No paste-able code path.** Users on a different device than where they
   read email, or with strict link-rewriting (corporate filters that mangle
   one-time links), can't sign in.
2. **No bot protection on `/api/auth/request`.** Anyone can hammer it with
   arbitrary emails to enumerate admins and burn email-send quota.

`../auth.ljs.app` already solved both — port the same pattern here.

## Acceptance Criteria

- Email sent on sign-in request contains **both** the magic link (existing)
  **and** a 6-digit numeric code, formatted as `123 456` for readability,
  in the same email body (HTML + text).
- New endpoint `POST /api/auth/verify-code` accepts `{ email, code }`,
  consumes the matching `magic_links` row atomically (same one-time-use
  semantics as the link), issues a session cookie, returns `{ ok: true }`
  or the redirect target.
- Admin sign-in UI (`admin/views/signin.ts`) gets a two-step flow:
  step 1 = email + Turnstile widget, step 2 = code input
  (`inputmode="numeric"`, `autocomplete="one-time-code"`, 6 chars).
  "Resend code" link on step 2.
- Cloudflare Turnstile human check on `POST /api/auth/request`:
  - If `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are both set,
    require a valid `turnstileToken` in the request body and verify it
    against `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
  - If either is unset, skip the check (dev mode). Mirror
    `auth.ljs.app/src/routes/auth.ts` `verifyTurnstile()` behavior.
- Codes inherit the existing magic-link expiry (15 min) and one-time-use
  guarantee. Reuse the same `magic_links` row — add a `code` column.
- Tests:
  - `tests/magic-link.test.ts` extended: verify-code happy path,
    wrong code, expired code, already-used code.
  - Turnstile path: secret unset → bypass; secret set + missing token → 400;
    secret set + invalid token → 400; secret set + valid stubbed response → 200.

## Relevant Files

- `server/lib/magic-link.ts` — generate code, render code into email
- `server/routes/admin/auth.ts` — `/request`, add `/verify-code`, Turnstile check
- `admin/views/signin.ts` — two-step UI + Turnstile widget
- `packages/db/` — migration adding `code TEXT` column to `magic_links`
- `tests/magic-link.test.ts` — new test cases
- Reference implementation (read-only): `../auth.ljs.app/src/routes/auth.ts`,
  `../auth.ljs.app/src/routes/login.ts`, `../auth.ljs.app/src/services/email.ts`

## Constraints

- **Keep magic-link flow working.** Adding the code is additive; existing
  `/api/auth/verify?token=…` continues to work unchanged.
- **Per-tenant fan-out preserved.** Each tenant that the email maps to gets
  its own `magic_links` row → its own email → its own code. The code is
  unique per row, not per email-address. Verify-code lookup is
  `(code, email)` — first matching un-expired, un-used row wins.
- **Turnstile is env-gated, not feature-gated.** If keys aren't configured,
  the endpoint silently skips. Don't add a separate feature flag — the
  presence/absence of secrets is the switch.
- **No external auth dependency.** Do not redirect to `auth.ljs.app`; this
  is bulletin-mail's own admin auth. The reference is the pattern, not a
  shared service.
- Generate codes via `crypto.getRandomValues` modulo 1_000_000, zero-padded
  to 6 digits — same approach as `auth.ljs.app`.
