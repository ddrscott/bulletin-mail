/**
 * GET /api/me — host-aware. Dispatches:
 *   - app.<apex>     → { kind: "site",   siteAdmin, tenants[] }
 *   - <tenant>.<apex> → { kind: "tenant", admin,    tenant     }
 *
 * The SPA branches its home view on this `kind` field.
 *
 * 404 if the request hits neither apex/admin nor a valid tenant subdomain.
 * 401 if cookie missing/expired in either context.
 */

import type { Hono, Context } from "hono";
import {
  getSiteAdminById,
  listTenants,
  type SiteAdmin,
} from "@bulletinmail/db";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import {
  readSiteCookieFromHeader,
  verifySiteSessionCookie,
} from "../../lib/site-session.js";
import { resolveTenantContext } from "../../wiki/tenant-auth.js";
import { currentTenantSlug } from "./tenant-middleware.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountMe(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/api/me", async (c) => {
    const host = c.req.header("Host") ?? "";
    const kind = classifyHost(host, c.var.config).kind;
    if (kind === "admin") return handleSiteMe(c);
    if (kind === "tenant") return handleTenantMe(c);
    return c.text("Not found", 404);
  });
}

async function handleSiteMe(c: Ctx): Promise<Response> {
  const siteAdmin = await loadSiteAdminFromCookie(c);
  if (!siteAdmin) return c.json({ error: "unauthorized" }, 401);

  const tenants = await listTenants(c.env.DB);
  return c.json({
    kind: "site",
    siteAdmin: {
      id: siteAdmin.id,
      email: siteAdmin.email,
      role: siteAdmin.role,
      displayName: siteAdmin.display_name,
    },
    tenants: tenants.map((t) => ({
      id: t.id, slug: t.slug, displayName: t.display_name,
      plan: t.plan, status: t.status, createdAt: t.created_at,
    })),
  });
}

async function handleTenantMe(c: Ctx): Promise<Response> {
  const slug = currentTenantSlug(c);
  if (!slug) return c.text("Not found", 404);
  const result = await resolveTenantContext({
    db: c.env.DB,
    cookieHeader: c.req.header("Cookie"),
    tenantSlug: slug,
    secret: c.env.ADMIN_API_JWT_SECRET,
  });
  if (!result.tenant) return c.text("Not found", 404);
  if (!result.admin) return c.json({ error: "unauthorized" }, 401);

  const { tenant, admin } = result;
  return c.json({
    kind: "tenant",
    admin: {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      displayName: admin.display_name,
    },
    tenant: { id: tenant.id, slug: tenant.slug, displayName: tenant.display_name },
  });
}

async function loadSiteAdminFromCookie(c: Ctx): Promise<SiteAdmin | null> {
  const secret = c.env.ADMIN_API_JWT_SECRET;
  if (!secret) return null;
  const cookie = readSiteCookieFromHeader(c.req.header("Cookie"));
  if (!cookie) return null;
  const payload = await verifySiteSessionCookie(cookie, secret);
  if (!payload) return null;
  return getSiteAdminById(c.env.DB, payload.siteAdminId);
}
