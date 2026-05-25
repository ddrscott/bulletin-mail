/**
 * Admin surface — mounted on both app.<apex> and <tenant>.<apex>.
 *
 * Each child mount uses middleware that gates on the appropriate host:
 *   - Site-admin routes (mountTenants, mountMe.site-branch) → admin host
 *   - Tenant-admin routes (mountGroups, mountMembers, mountPending,
 *     mountTeam) → tenant host
 *   - Auth routes (mountAuth, mountMe) → both, with internal host-dispatch
 *
 * Static SPA assets at /admin (and /) come from the [assets] binding via the
 * fallback below. For the admin host, / serves the SPA; for tenant hosts,
 * /admin serves it (and the wiki claims /).
 */

import type { Hono } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import { mountAuth } from "./auth.js";
import { mountMe } from "./me.js";
import { mountGroups } from "./groups.js";
import { mountMembers } from "./members.js";
import { mountPending } from "./pending.js";
import { mountTeam } from "./team.js";
import { mountTenants } from "./tenants.js";
import { mountProfile } from "./profile.js";

export function mountAdmin(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  mountAuth(app);
  mountMe(app);
  mountProfile(app);
  // Site admin
  mountTenants(app);
  // Tenant admin
  mountGroups(app);
  mountMembers(app);
  mountPending(app);
  mountTeam(app);

  // Static SPA on the admin host. The SPA now lives at dist/admin/ so its
  // URL is /admin on every host. Apex / → redirect to /admin/.
  app.get("/", (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "admin") return next();
    return c.redirect("/admin/", 302);
  });
  app.all("*", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "admin") return next();
    return c.env.ASSETS.fetch(c.req.raw);
  });
}

/**
 * Tenant subdomain — serve /admin/* via the Assets binding. The binding's
 * dist/admin/index.html serves automatically; no URL rewriting needed.
 */
export function mountTenantAdminSpa(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.all("/admin", (c) => c.env.ASSETS.fetch(c.req.raw));
  app.all("/admin/*", (c) => c.env.ASSETS.fetch(c.req.raw));
}
