/**
 * Apex archive short-link — /g/:tenant/:group.
 *
 * The real archive browser lives on the tenant subdomain
 * (<tenant>.<apex>/archive/<group>, see server/archive/routes.ts). This
 * apex route exists because the INSTANCE_ARCHIVE_URL template in older
 * outbound mail footers points here — it 302s to the canonical location.
 * Access control happens there, not here.
 *
 * IMPORTANT: apex-only. Must `return next()` for subdomain hosts so the
 * tenant catch-all picks them up. (In single-tenant mode the apex itself
 * classifies as the tenant, so this route never fires — the tenant-side
 * /archive routes serve the apex directly.)
 */

import type { Hono } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../types.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function mountArchive(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/g/:tenant/:group", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "apex") return next();

    const tenant = c.req.param("tenant").toLowerCase();
    const group = c.req.param("group").toLowerCase();
    if (!SLUG_RE.test(tenant) || !SLUG_RE.test(group)) {
      return c.text("Not found", 404);
    }
    return c.redirect(
      `https://${tenant}.${c.var.config.apexDomain}/archive/${group}`,
      302,
    );
  });
}
