/**
 * Auth endpoints, host-aware. All /api/auth/* requests dispatch by Host:
 *
 *   app.<apex>      → site admin auth (site_admins, bm_site_session)
 *   <tenant>.<apex> → tenant admin auth (admins, bm_tenant_session)
 *
 * The two sessions never collide because their cookies have different names
 * and the magic-link verify endpoints rebind to host-specific cookies.
 *
 *   GET  /api/auth/signup-available   true iff bootstrap is allowed
 *   POST /api/auth/signup             { email } → bootstrap first admin
 *   POST /api/auth/request            { email } → magic-link sign-in
 *   POST /api/auth/signout            clear cookie for current host
 *   GET  /auth/verify?token=...       site-host only; tenant /auth/verify
 *                                       lives in wiki/routes.ts
 *
 * The tenant-host signup verify URL points at the tenant host so the
 * resulting session cookie lands on the right host.
 */

import type { Hono, Context } from "hono";
import {
  consumeMagicLinkByCode,
  consumeMemberMagicLink,
  consumeSiteMagicLinkByCode,
  countAdminsByTenant,
  listMemberGroupIds,
  countSiteAdmins,
  createMagicLink,
  createSiteAdmin,
  createSiteMagicLink,
  consumeSiteMagicLink,
  createTenantWithFirstAdmin,
  getAdminsByEmail,
  getSiteAdminByEmail,
  getTenantBySlug,
  insertTenantAdmin,
} from "@bulletinmail/db";
import {
  classifyHost,
  fetchGravatarDisplayName,
  singleTenantSlug,
  systemAddress,
  type InstanceConfig,
} from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import {
  buildSiteClearCookie,
  buildSiteSetCookie,
  issueSiteSessionCookie,
} from "../../lib/site-session.js";
import {
  buildTenantClearCookie,
  buildTenantSetCookie,
  consumeTenantMagicLink,
  issueTenantSessionCookie,
} from "../../wiki/tenant-auth.js";
import { generateSixDigitCode, formatSixDigitCode } from "../../lib/magic-link.js";
import {
  buildMemberSetCookie,
  issueMemberSessionCookie,
} from "../../archive/member-auth.js";
import { safeReturnTo } from "../../archive/routes.js";
import { verifyTurnstile } from "../../lib/turnstile.js";
import { currentTenantSlug } from "./tenant-middleware.js";

const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIX_DIGIT_RE = /^\d{6}$/;

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountAuth(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  // Public config for the sign-in page — namely the Turnstile site key when
  // configured. Site keys are not secret (they're served to every browser
  // that loads the challenge widget); only the secret is. Returning null for
  // `turnstileSiteKey` signals to the SPA that it should skip mounting the
  // widget and submit without a token — which the server-side check will
  // also bypass because TURNSTILE_SECRET_KEY is unset.
  app.get("/api/auth/config", (c) => {
    const siteKey = typeof c.env.TURNSTILE_SITE_KEY === "string" && c.env.TURNSTILE_SITE_KEY
      ? c.env.TURNSTILE_SITE_KEY
      : null;
    return c.json({ turnstileSiteKey: siteKey });
  });

  app.get("/api/auth/signup-available", async (c) => {
    const kind = hostKind(c);
    if (kind === "apex") {
      return c.json({ available: (await countSiteAdmins(c.env.DB)) === 0 });
    }
    if (kind === "tenant") {
      const tenant = await currentTenant(c);
      // Single-tenant mode: on first visit the 'main' tenant doesn't exist
      // yet. Treat that as "signup is open" so the bootstrap path can run.
      if (!tenant) {
        const bootstrapSlug = singleTenantSlug(c.var.config);
        if (bootstrapSlug && currentTenantSlug(c) === bootstrapSlug) {
          return c.json({ available: true });
        }
        return c.text("Not found", 404);
      }
      return c.json({ available: (await countAdminsByTenant(c.env.DB, tenant.id)) === 0 });
    }
    return c.text("Not found", 404);
  });

  app.post("/api/auth/signup", async (c) => {
    const kind = hostKind(c);
    if (kind === "apex") return siteSignup(c);
    if (kind === "tenant") return tenantSignup(c);
    return c.text("Not found", 404);
  });

  app.post("/api/auth/request", async (c) => {
    const kind = hostKind(c);
    if (kind === "apex") return siteRequest(c);
    if (kind === "tenant") return tenantRequest(c);
    return c.text("Not found", 404);
  });

  // POST /api/auth/verify-code  { email, code } → consume code, set cookie,
  // return { ok, redirect }. Host-aware: apex consumes site_magic_links and
  // sets bm_site_session; tenant subdomain consumes magic_links scoped to
  // the resolved tenant and sets bm_tenant_session.
  app.post("/api/auth/verify-code", async (c) => {
    const kind = hostKind(c);
    if (kind === "apex") return siteVerifyCode(c);
    if (kind === "tenant") return tenantVerifyCode(c);
    return c.text("Not found", 404);
  });

  app.post("/api/auth/signout", (c) => {
    const kind = hostKind(c);
    if (kind === "apex") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": buildSiteClearCookie() } });
    }
    if (kind === "tenant") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": buildTenantClearCookie() } });
    }
    return c.text("Not found", 404);
  });

  // /auth/verify — host-aware. On apex, consumes site_magic_links and sets
  // bm_site_session. On tenant host, consumes magic_links and sets
  // bm_tenant_session. One handler so Hono doesn't pick the wrong one by
  // registration order.
  app.get("/auth/verify", async (c) => {
    const kind = hostKind(c);
    const token = c.req.query("token");
    if (!token) return c.html(errorPage("Missing token."), 400);

    if (kind === "apex") {
      const siteAdmin = await consumeSiteMagicLink(c.env.DB, token, Date.now());
      if (!siteAdmin) return c.html(errorPage("Link is invalid, expired, or already used."), 400);
      const cookieValue = await issueSiteSessionCookie(siteAdmin.id, c.env.ADMIN_API_JWT_SECRET);
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/", "Set-Cookie": buildSiteSetCookie(cookieValue) },
      });
    }
    if (kind === "tenant") {
      const tenant = await currentTenant(c);
      if (!tenant) return c.html(errorPage("Tenant not found."), 404);
      const returnTo = safeReturnTo(c.req.query("rt") ?? "");

      // Admin/moderator token first (magic_links) …
      const admin = await consumeTenantMagicLink(c.env.DB, token, tenant);
      if (admin) {
        const cookieValue = await issueTenantSessionCookie(admin.id, tenant.id, c.env.ADMIN_API_JWT_SECRET);
        return new Response(null, {
          status: 302,
          headers: {
            Location: returnTo ?? "/admin/",
            "Set-Cookie": buildTenantSetCookie(cookieValue),
          },
        });
      }

      // … then member token (member_magic_links) — archive sign-in. Re-check
      // active membership at verify time so a token outlives an unsubscribe
      // by exactly nothing.
      const memberEmail = await consumeMemberMagicLink(c.env.DB, token, tenant.id, Date.now());
      if (memberEmail) {
        const groupIds = await listMemberGroupIds(c.env.DB, tenant.id, memberEmail);
        if (groupIds.length > 0) {
          const cookieValue = await issueMemberSessionCookie(memberEmail, tenant.id, c.env.ADMIN_API_JWT_SECRET);
          return new Response(null, {
            status: 302,
            headers: {
              Location: returnTo ?? "/archive",
              "Set-Cookie": buildMemberSetCookie(cookieValue),
            },
          });
        }
      }
      return c.html(errorPage("Link is invalid, expired, or not authorized for this tenant."), 400);
    }
    return c.text("Not found", 404);
  });
}

// ---- site-admin (apex /admin) ---------------------------------------------

async function siteSignup(c: Ctx): Promise<Response> {
  if ((await countSiteAdmins(c.env.DB)) > 0) return c.json({ error: "signup_closed" }, 403);
  const body = await safeJson<{ email?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

  const displayName = await fetchGravatarDisplayName(email);
  const { id } = await createSiteAdmin(c.env.DB, email, displayName);
  c.executionCtx.waitUntil(sendSiteMagicLink(c.env, c.var.config, id, email));
  return c.body(null, 204);
}

async function siteRequest(c: Ctx): Promise<Response> {
  const body = await safeJson<{ email?: string; turnstileToken?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

  // Bot protection: only enforced when the Turnstile secret is configured.
  // The dev path (no secret) returns true unconditionally so local sign-in
  // continues to work without standing up Turnstile keys.
  const humanOk = await verifyTurnstile(
    typeof c.env.TURNSTILE_SECRET_KEY === "string" ? c.env.TURNSTILE_SECRET_KEY : undefined,
    body?.turnstileToken,
    c.req.header("cf-connecting-ip") ?? undefined,
  );
  if (!humanOk) return c.json({ error: "human_check_failed" }, 400);

  const admin = await getSiteAdminByEmail(c.env.DB, email);
  if (admin) c.executionCtx.waitUntil(sendSiteMagicLink(c.env, c.var.config, admin.id, email));
  return c.body(null, 204);
}

async function siteVerifyCode(c: Ctx): Promise<Response> {
  const body = await safeJson<{ email?: string; code?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  const code = body?.code?.replace(/\s/g, "");
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  if (!code || !SIX_DIGIT_RE.test(code)) return c.json({ error: "invalid_code" }, 400);

  const siteAdmin = await consumeSiteMagicLinkByCode(c.env.DB, email, code, Date.now());
  if (!siteAdmin) return c.json({ error: "invalid_code" }, 400);

  const cookieValue = await issueSiteSessionCookie(siteAdmin.id, c.env.ADMIN_API_JWT_SECRET);
  return new Response(
    JSON.stringify({ ok: true, redirect: "/admin/" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSiteSetCookie(cookieValue),
      },
    },
  );
}

async function sendSiteMagicLink(
  env: Env,
  config: InstanceConfig,
  siteAdminId: string,
  email: string,
): Promise<void> {
  const token = randomToken();
  const code = generateSixDigitCode();
  await createSiteMagicLink(env.DB, token, siteAdminId, Date.now() + MAGIC_LINK_LIFETIME_MS, code);

  const verifyUrl = `https://${config.apexDomain}/auth/verify?token=${token}`;
  const from = systemAddress(config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const formattedCode = formatSixDigitCode(code);
  // Vary the subject per request so Gmail doesn't thread successive sign-in
  // emails together (which buries the newest link at the bottom of the
  // conversation, behind expired ones). The 8-char token prefix is unique
  // by construction and the timestamp gives a human-readable cue.
  const subjectSuffix = `${timestampLabel(Date.now())} · ${token.slice(0, 8)}`;
  try {
    await env.EMAIL.send({
      to: email, from,
      subject: `Sign in to ${config.productName} (site admin) — ${subjectSuffix}`,
      text: `Click the link below to sign in to ${config.productName} as a site admin:\n\n${verifyUrl}\n\nOr paste this 6-digit code into the sign-in page:\n\n    ${formattedCode}\n\nLink expires in 15 minutes.`,
      html: `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Sign in to ${esc(config.productName)} (site admin)</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="margin-top:1.5rem">Or paste this 6-digit code into the sign-in page:</p>
<p style="margin:0.5rem 0"><code style="display:inline-block;padding:0.5rem 0.9rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;font:600 1.1rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.08em">${esc(formattedCode)}</code></p>
<p style="color:#666;font-size:0.875rem">Link and code expire in 15 minutes.</p>
</body></html>`,
      headers: { "X-Bulletin-Purpose": "site-magic-link" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("site magic-link send failed", err);
  }
}

// ---- tenant-admin (<tenant>.<apex>) ---------------------------------------

async function tenantSignup(c: Ctx): Promise<Response> {
  const tenant = await currentTenant(c);

  // Single-tenant bootstrap: lone tenant doesn't exist yet, AND the slug we'd
  // look up matches the configured single-tenant slug (the same string used
  // as the mail subdomain). Create the tenant + first admin atomically.
  // Subsequent signups fall into the normal "signup_closed" path because
  // countAdminsByTenant > 0.
  if (!tenant) {
    const bootstrapSlug = singleTenantSlug(c.var.config);
    if (bootstrapSlug && currentTenantSlug(c) === bootstrapSlug) {
      const body = await safeJson<{ email?: string }>(c.req.raw);
      const email = body?.email?.trim().toLowerCase();
      if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

      const displayName = await fetchGravatarDisplayName(email);
      const { adminId } = await createTenantWithFirstAdmin(c.env.DB, {
        slug: bootstrapSlug,
        displayName: c.var.config.productName,
        adminEmail: email,
        adminDisplayName: displayName,
      });
      c.executionCtx.waitUntil(sendTenantMagicLink(c, adminId, email));
      return c.body(null, 204);
    }
    return c.text("Not found", 404);
  }

  if ((await countAdminsByTenant(c.env.DB, tenant.id)) > 0) {
    return c.json({ error: "signup_closed" }, 403);
  }

  const body = await safeJson<{ email?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

  const displayName = await fetchGravatarDisplayName(email);
  const adminId = await insertTenantAdmin(c.env.DB, {
    tenantId: tenant.id, email, role: "admin", displayName,
  });
  if (!adminId) return c.json({ error: "email_taken" }, 409);
  c.executionCtx.waitUntil(sendTenantMagicLink(c, adminId, email));
  return c.body(null, 204);
}

async function tenantRequest(c: Ctx): Promise<Response> {
  const tenant = await currentTenant(c);
  if (!tenant) {
    // Single-tenant mode pre-bootstrap: no tenant row yet. Silently 204
    // to match the existing "don't leak which emails are registered"
    // behavior below. The SPA should be calling /signup, not /request,
    // at this point — but a request that arrives here just no-ops.
    const bootstrapSlug = singleTenantSlug(c.var.config);
    if (bootstrapSlug && currentTenantSlug(c) === bootstrapSlug) {
      return c.body(null, 204);
    }
    return c.text("Not found", 404);
  }
  const body = await safeJson<{ email?: string; turnstileToken?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

  const humanOk = await verifyTurnstile(
    typeof c.env.TURNSTILE_SECRET_KEY === "string" ? c.env.TURNSTILE_SECRET_KEY : undefined,
    body?.turnstileToken,
    c.req.header("cf-connecting-ip") ?? undefined,
  );
  if (!humanOk) return c.json({ error: "human_check_failed" }, 400);

  const admins = await getAdminsByEmail(c.env.DB, email);
  const match = admins.find((a) => a.tenant_id === tenant.id);
  if (match) c.executionCtx.waitUntil(sendTenantMagicLink(c, match.id, email));
  return c.body(null, 204);
}

async function tenantVerifyCode(c: Ctx): Promise<Response> {
  const tenant = await currentTenant(c);
  if (!tenant) return c.text("Not found", 404);

  const body = await safeJson<{ email?: string; code?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  const code = body?.code?.replace(/\s/g, "");
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  if (!code || !SIX_DIGIT_RE.test(code)) return c.json({ error: "invalid_code" }, 400);

  const admin = await consumeMagicLinkByCode(c.env.DB, tenant.id, email, code, Date.now());
  if (!admin) return c.json({ error: "invalid_code" }, 400);

  const cookieValue = await issueTenantSessionCookie(admin.id, tenant.id, c.env.ADMIN_API_JWT_SECRET);
  return new Response(
    JSON.stringify({ ok: true, redirect: "/admin/" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildTenantSetCookie(cookieValue),
      },
    },
  );
}

async function sendTenantMagicLink(c: Ctx, adminId: string, email: string): Promise<void> {
  const config = c.var.config;
  const host = c.req.header("Host") ?? "";
  const token = randomToken();
  const code = generateSixDigitCode();
  await createMagicLink(c.env.DB, token, adminId, Date.now() + MAGIC_LINK_LIFETIME_MS, code);

  const verifyUrl = `https://${host}/auth/verify?token=${token}`;
  const from = systemAddress(config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const formattedCode = formatSixDigitCode(code);
  // See site magic-link comment — vary the subject so Gmail doesn't thread.
  const subjectSuffix = `${timestampLabel(Date.now())} · ${token.slice(0, 8)}`;
  try {
    await c.env.EMAIL.send({
      to: email, from,
      subject: `Sign in to ${config.productName} — ${subjectSuffix}`,
      text: `Click below to sign in:\n\n${verifyUrl}\n\nOr paste this 6-digit code into the sign-in page:\n\n    ${formattedCode}\n\nLink and code expire in 15 minutes.`,
      html: `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Sign in</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="margin-top:1.5rem">Or paste this 6-digit code into the sign-in page:</p>
<p style="margin:0.5rem 0"><code style="display:inline-block;padding:0.5rem 0.9rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;font:600 1.1rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.08em">${esc(formattedCode)}</code></p>
<p style="color:#666;font-size:0.875rem">Link and code expire in 15 minutes.</p>
</body></html>`,
      headers: { "X-Bulletin-Purpose": "tenant-magic-link" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("tenant magic-link send failed", err);
  }
}

// ---- helpers ----------------------------------------------------------------

function hostKind(c: Ctx): "tenant" | "apex" | "unknown" {
  return classifyHost(c.req.header("Host") ?? "", c.var.config).kind;
}

async function currentTenant(c: Ctx) {
  const slug = currentTenantSlug(c);
  if (!slug) return null;
  const t = await getTenantBySlug(c.env.DB, slug);
  if (!t || t.status !== "active") return null;
  return t;
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

function validEmail(s: string): boolean {
  return EMAIL_RE.test(s) && s.length <= 254;
}

function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Short 'MMM D HH:mm' UTC label for magic-link email subjects so each
 * request produces a unique subject and Gmail doesn't thread them. */
function timestampLabel(now: number): string {
  const d = new Date(now);
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]!;
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} ${hh}:${mm} UTC`;
}

function errorPage(message: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}a{color:#0f172a}</style>
</head><body><h1>Sign-in failed</h1><p>${esc(message)}</p><p><a href="/">Try again</a></p></body></html>`;
}
