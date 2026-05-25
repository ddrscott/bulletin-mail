/**
 * requireTenantAdmin — Hono middleware for <tenant>.<apex>. Resolves tenant
 * from Host header, verifies bm_tenant_session cookie, loads admin row, and
 * additionally re-checks that admin.tenant_id matches the host's tenant. The
 * tenant + admin land in `c.var.tenant` and `c.var.admin` respectively.
 *
 * Most existing tenant-admin route handlers do `c.var.admin!` and expect
 * `admin.tenant_id` to be the active tenant — preserving that semantics
 * keeps the rewrite minimal.
 *
 * Authorization model (V2):
 *   - role 'admin'     → full tenant control (passes through here)
 *   - role 'moderator' → wiki + subscribe pending only (also passes here,
 *                        but individual route handlers may gate further)
 *
 * Wrong host → 404. No cookie → 401 (or HTML redirect to /auth/sign-in for
 * GETs with Accept: text/html, similar to the wiki-route auth).
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "../../types.js";
import { resolveTenantContext } from "../../wiki/tenant-auth.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export const requireTenantAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const slug = currentTenantSlug(c);
  if (!slug) return c.text("Not found", 404);
  const result = await resolveTenantContext({
    db: c.env.DB,
    cookieHeader: c.req.header("Cookie"),
    tenantSlug: slug,
    secret: c.env.ADMIN_API_JWT_SECRET,
  });
  if (!result.tenant) return c.text("Not found", 404);
  if (!result.admin) {
    const accept = c.req.header("Accept") ?? "";
    if (accept.includes("text/html") && c.req.method === "GET") {
      const path = new URL(c.req.url).pathname;
      return new Response(null, {
        status: 302,
        headers: { Location: `/auth/sign-in?return_to=${encodeURIComponent(path)}` },
      });
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("tenant", result.tenant);
  c.set("admin", result.admin);
  await next();
};

export function currentTenantSlug(c: Ctx): string | null {
  const host = (c.req.header("Host") ?? "").toLowerCase();
  const apex = c.var.config.apexDomain.toLowerCase();
  if (!host.endsWith(`.${apex}`)) return null;
  const slug = host.slice(0, host.length - apex.length - 1);
  if (!slug || slug === "app" || slug === "www") return null;
  return slug;
}

/** Stricter: only role='admin' (not moderator) may proceed. */
export const requireTenantAdminRole: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  // Caller is expected to chain after requireTenantAdmin; we only re-check
  // the role here.
  const admin = c.var.admin;
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  if (admin.role !== "admin" && admin.role !== "super_admin") {
    return c.json({ error: "forbidden", reason: "admin role required" }, 403);
  }
  await next();
};
