/**
 * PATCH /api/profile — host-aware. Lets the signed-in user override their
 * own display_name (the one Gravatar pre-filled at insert time).
 *
 * Only display_name is editable in V1. Email + role + tenant are not.
 *
 * Site host: updates site_admins.display_name for the bm_site_session admin.
 * Tenant host: updates admins.display_name for the bm_tenant_session admin.
 */

import type { Hono, Context } from "hono";
import {
  getSiteAdminById,
  updateAdminDisplayName,
  updateSiteAdminDisplayName,
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

export function mountProfile(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.patch("/api/profile", async (c) => {
    const kind = classifyHost(c.req.header("Host") ?? "", c.var.config).kind;
    if (kind === "admin") return handleSite(c);
    if (kind === "tenant") return handleTenant(c);
    return c.text("Not found", 404);
  });
}

async function handleSite(c: Ctx): Promise<Response> {
  const secret = c.env.ADMIN_API_JWT_SECRET;
  const cookie = readSiteCookieFromHeader(c.req.header("Cookie"));
  if (!cookie) return c.json({ error: "unauthorized" }, 401);
  const payload = await verifySiteSessionCookie(cookie, secret);
  if (!payload) return c.json({ error: "unauthorized" }, 401);
  const siteAdmin = await getSiteAdminById(c.env.DB, payload.siteAdminId);
  if (!siteAdmin) return c.json({ error: "unauthorized" }, 401);

  const body = await safeJson<{ displayName?: string | null }>(c.req.raw);
  const name = normalizeName(body?.displayName);
  if (name === undefined) return c.json({ error: "missing_display_name" }, 400);
  await updateSiteAdminDisplayName(c.env.DB, siteAdmin.id, name);
  return c.json({ displayName: name });
}

async function handleTenant(c: Ctx): Promise<Response> {
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

  const body = await safeJson<{ displayName?: string | null }>(c.req.raw);
  const name = normalizeName(body?.displayName);
  if (name === undefined) return c.json({ error: "missing_display_name" }, 400);
  await updateAdminDisplayName(c.env.DB, result.admin.id, name);
  return c.json({ displayName: name });
}

/**
 * Accept string (set), explicit null (clear), or undefined (reject). Returns
 * the canonical value to persist, or undefined to signal "missing field".
 */
function normalizeName(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) return trimmed.slice(0, 120);
  return trimmed;
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}
