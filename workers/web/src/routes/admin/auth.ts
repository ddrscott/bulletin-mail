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
  countAdminsByTenant,
  countSiteAdmins,
  createMagicLink,
  createSiteAdmin,
  createSiteMagicLink,
  consumeSiteMagicLink,
  getAdminsByEmail,
  getSiteAdminByEmail,
  getTenantBySlug,
  insertTenantAdmin,
} from "@bulletinmail/db";
import { classifyHost, fetchGravatarDisplayName, systemAddress, type InstanceConfig } from "@bulletinmail/shared";
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
import { currentTenantSlug } from "./tenant-middleware.js";

const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountAuth(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/api/auth/signup-available", async (c) => {
    const kind = hostKind(c);
    if (kind === "admin") {
      return c.json({ available: (await countSiteAdmins(c.env.DB)) === 0 });
    }
    if (kind === "tenant") {
      const tenant = await currentTenant(c);
      if (!tenant) return c.text("Not found", 404);
      return c.json({ available: (await countAdminsByTenant(c.env.DB, tenant.id)) === 0 });
    }
    return c.text("Not found", 404);
  });

  app.post("/api/auth/signup", async (c) => {
    const kind = hostKind(c);
    if (kind === "admin") return siteSignup(c);
    if (kind === "tenant") return tenantSignup(c);
    return c.text("Not found", 404);
  });

  app.post("/api/auth/request", async (c) => {
    const kind = hostKind(c);
    if (kind === "admin") return siteRequest(c);
    if (kind === "tenant") return tenantRequest(c);
    return c.text("Not found", 404);
  });

  app.post("/api/auth/signout", (c) => {
    const kind = hostKind(c);
    if (kind === "admin") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": buildSiteClearCookie() } });
    }
    if (kind === "tenant") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": buildTenantClearCookie() } });
    }
    return c.text("Not found", 404);
  });

  // /auth/verify — host-aware. On admin host, consumes site_magic_links and
  // sets bm_site_session. On tenant host, consumes magic_links and sets
  // bm_tenant_session. One handler so Hono doesn't pick the wrong one by
  // registration order (the wiki module also defined this path historically;
  // that registration is removed now).
  app.get("/auth/verify", async (c) => {
    const kind = hostKind(c);
    const token = c.req.query("token");
    if (!token) return c.html(errorPage("Missing token."), 400);

    if (kind === "admin") {
      const siteAdmin = await consumeSiteMagicLink(c.env.DB, token, Date.now());
      if (!siteAdmin) return c.html(errorPage("Link is invalid, expired, or already used."), 400);
      const cookieValue = await issueSiteSessionCookie(siteAdmin.id, c.env.ADMIN_API_JWT_SECRET);
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": buildSiteSetCookie(cookieValue) },
      });
    }
    if (kind === "tenant") {
      const tenant = await currentTenant(c);
      if (!tenant) return c.html(errorPage("Tenant not found."), 404);
      const admin = await consumeTenantMagicLink(c.env.DB, token, tenant);
      if (!admin) {
        return c.html(errorPage("Link is invalid, expired, or not authorized for this tenant."), 400);
      }
      const cookieValue = await issueTenantSessionCookie(admin.id, tenant.id, c.env.ADMIN_API_JWT_SECRET);
      return new Response(null, {
        status: 302,
        headers: { Location: "/admin/", "Set-Cookie": buildTenantSetCookie(cookieValue) },
      });
    }
    return c.text("Not found", 404);
  });
}

// ---- site-admin (app.<apex>) ----------------------------------------------

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
  const body = await safeJson<{ email?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  const admin = await getSiteAdminByEmail(c.env.DB, email);
  if (admin) c.executionCtx.waitUntil(sendSiteMagicLink(c.env, c.var.config, admin.id, email));
  return c.body(null, 204);
}

async function sendSiteMagicLink(
  env: Env,
  config: InstanceConfig,
  siteAdminId: string,
  email: string,
): Promise<void> {
  const token = randomToken();
  await createSiteMagicLink(env.DB, token, siteAdminId, Date.now() + MAGIC_LINK_LIFETIME_MS);

  const verifyUrl = `https://${config.adminDomain}/auth/verify?token=${token}`;
  const from = systemAddress(config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  try {
    await env.EMAIL.send({
      to: email, from,
      subject: `Sign in to ${config.productName} (site admin)`,
      text: `Click the link below to sign in to ${config.productName} as a site admin:\n\n${verifyUrl}\n\nLink expires in 15 minutes.`,
      html: `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Sign in to ${esc(config.productName)} (site admin)</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="color:#666;font-size:0.875rem">Link expires in 15 minutes.</p>
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
  if (!tenant) return c.text("Not found", 404);

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
  if (!tenant) return c.text("Not found", 404);
  const body = await safeJson<{ email?: string }>(c.req.raw);
  const email = body?.email?.trim().toLowerCase();
  if (!email || !validEmail(email)) return c.json({ error: "invalid_email" }, 400);

  const admins = await getAdminsByEmail(c.env.DB, email);
  const match = admins.find((a) => a.tenant_id === tenant.id);
  if (match) c.executionCtx.waitUntil(sendTenantMagicLink(c, match.id, email));
  return c.body(null, 204);
}

async function sendTenantMagicLink(c: Ctx, adminId: string, email: string): Promise<void> {
  const config = c.var.config;
  const host = c.req.header("Host") ?? "";
  const token = randomToken();
  await createMagicLink(c.env.DB, token, adminId, Date.now() + MAGIC_LINK_LIFETIME_MS);

  const verifyUrl = `https://${host}/auth/verify?token=${token}`;
  const from = systemAddress(config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  try {
    await c.env.EMAIL.send({
      to: email, from,
      subject: `Sign in to ${config.productName}`,
      text: `Click below to sign in:\n\n${verifyUrl}\n\nLink expires in 15 minutes.`,
      html: `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Sign in</h1>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="color:#666;font-size:0.875rem">Link expires in 15 minutes.</p>
</body></html>`,
      headers: { "X-Bulletin-Purpose": "tenant-magic-link" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("tenant magic-link send failed", err);
  }
}

// ---- helpers ----------------------------------------------------------------

function hostKind(c: Ctx): "admin" | "tenant" | "apex" | "unknown" {
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

function errorPage(message: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}a{color:#0f172a}</style>
</head><body><h1>Sign-in failed</h1><p>${esc(message)}</p><p><a href="/">Try again</a></p></body></html>`;
}
