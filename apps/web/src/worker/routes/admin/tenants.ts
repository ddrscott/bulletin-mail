/**
 * POST /api/tenants — site-admin only. Atomically creates a tenant + its
 * first tenant admin (admins.role='admin'), then emails the admin a magic
 * link pointing at the TENANT subdomain (https://<slug>.<apex>/auth/verify).
 *
 * Bare-tenant or token-link handoff styles were explicitly rejected — the
 * site admin pre-specifies the first admin's email at create time and the
 * tenant is immediately bootstrapped.
 */

import type { Hono } from "hono";
import {
  createMagicLink,
  createTenantWithFirstAdmin,
  getTenantBySlug,
} from "@bulletinmail/db";
import { fetchGravatarDisplayName, systemAddress, validateTenantSlug } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import { requireSiteAdmin } from "./auth-middleware.js";

const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mountTenants(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.post("/api/tenants", requireSiteAdmin, async (c) => {
    const body = await safeJson<{
      slug?: string;
      displayName?: string;
      adminEmail?: string;
    }>(c.req.raw);

    const rawSlug = body?.slug?.trim();
    const displayName = body?.displayName?.trim();
    const adminEmail = body?.adminEmail?.trim().toLowerCase();
    if (!rawSlug) return c.json({ error: "missing_slug" }, 400);
    if (!displayName) return c.json({ error: "missing_display_name" }, 400);
    if (!adminEmail || !EMAIL_RE.test(adminEmail)) return c.json({ error: "invalid_email" }, 400);

    const slugCheck = validateTenantSlug(rawSlug, c.var.config);
    if (!slugCheck.ok) {
      return c.json({ error: "invalid_slug", reason: slugCheck.reason }, 400);
    }
    if (await getTenantBySlug(c.env.DB, slugCheck.slug)) {
      return c.json({ error: "slug_taken" }, 409);
    }

    const adminDisplayName = await fetchGravatarDisplayName(adminEmail);
    let result;
    try {
      result = await createTenantWithFirstAdmin(c.env.DB, {
        slug: slugCheck.slug,
        displayName,
        adminEmail,
        adminDisplayName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(msg)) return c.json({ error: "slug_taken" }, 409);
      throw err;
    }

    // Send the first tenant admin a magic link pointing at the tenant
    // subdomain. The tenant-auth /auth/verify endpoint will set
    // bm_tenant_session on that host.
    c.executionCtx.waitUntil(sendTenantHandoffEmail({
      env: c.env, config: c.var.config,
      tenantSlug: slugCheck.slug, tenantDisplayName: displayName,
      adminId: result.adminId, adminEmail,
    }));

    return c.json({
      tenant: { id: result.tenantId, slug: slugCheck.slug, displayName },
      adminId: result.adminId,
    }, 201);
  });
}

async function sendTenantHandoffEmail(input: {
  env: Env;
  config: import("@bulletinmail/shared").InstanceConfig;
  tenantSlug: string;
  tenantDisplayName: string;
  adminId: string;
  adminEmail: string;
}): Promise<void> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let token = "";
  for (let i = 0; i < buf.length; i++) token += buf[i]!.toString(16).padStart(2, "0");
  await createMagicLink(input.env.DB, token, input.adminId, Date.now() + MAGIC_LINK_LIFETIME_MS);

  const tenantHost = `${input.tenantSlug}.${input.config.apexDomain}`;
  const verifyUrl = `https://${tenantHost}/auth/verify?token=${token}`;
  const from = systemAddress(input.config, "noreply");
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  const subject = `You're the admin for ${input.tenantDisplayName} on ${input.config.productName}`;
  const text = [
    `A site admin created the ${input.tenantDisplayName} tenant on ${input.config.productName} and made you its first admin.`,
    "",
    `Click below to sign in and finish setup:`,
    verifyUrl,
    "",
    `Your admin URL: https://${tenantHost}/admin`,
    "",
    "This link expires in 15 minutes. If you didn't expect this email, ignore it.",
  ].join("\n");

  const html = `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.25rem">Welcome to ${esc(input.config.productName)}</h1>
<p>A site admin created <strong>${esc(input.tenantDisplayName)}</strong> and made you its first admin.</p>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in and finish setup</a></p>
<p style="color:#666;font-size:0.875rem">Your admin URL: <code>https://${esc(tenantHost)}/admin</code></p>
<p style="color:#666;font-size:0.875rem">This link expires in 15 minutes.</p>
</body></html>`;

  try {
    await input.env.EMAIL.send({
      to: input.adminEmail, from, subject, text, html,
      headers: { "X-Bulletin-Purpose": "tenant-handoff" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("tenant handoff send failed", err);
  }
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}
