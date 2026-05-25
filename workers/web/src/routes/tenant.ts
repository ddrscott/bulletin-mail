/**
 * Per-tenant subdomain catch-all — <tenant>.<apex>/*.
 *
 * For V1: redirects HTTP requests at the tenant subdomain to the apex archive
 * URL (or the apex landing if the path doesn't map). The tenant subdomain
 * exists primarily for inbound email (`*@<tenant>.<apex>`); HTTP is a
 * convenience.
 *
 * For V2: serve a tenant-branded archive landing page directly here.
 *
 * IMPORTANT: this must run AFTER all apex/admin routes — the relaytty
 * `extractSlug(host) → next()` pattern. Since this handler only fires when
 * classifyHost returns `tenant`, ordering is safe.
 */

import type { Hono } from "hono";
import { archiveUrl, classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../types.js";

export function mountTenant(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.all("*", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    const result = classifyHost(host, c.var.config);
    if (result.kind !== "tenant") return next();

    // /g/<group> on a tenant subdomain → canonical apex archive URL.
    const match = /^\/g\/([^/]+)$/.exec(new URL(c.req.url).pathname);
    if (match) {
      const groupName = match[1]!;
      return c.redirect(archiveUrl(c.var.config, result.slug, groupName), 301);
    }

    // Otherwise: tenant landing placeholder.
    return c.text(
      `${c.var.config.productName}: ${result.slug} (per-tenant page not yet implemented)`,
      200,
    );
  });
}
