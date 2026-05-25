/**
 * Admin app + admin API — served at app.<apex>/*.
 *
 * Phase 2. Static SPA shell + /api/* JSON endpoints. Magic-link auth, session
 * cookies (HttpOnly, Secure, SameSite=Lax). See PRD §10.
 *
 * Dispatched only when classifyHost returns { kind: 'admin' }. All other
 * traffic to this route prefix on apex/tenant hosts falls through.
 */

import type { Hono } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../types.js";

export function mountAdmin(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.all("*", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "admin") return next();

    return c.text("Admin app not implemented (Phase 2)", 501);
  });
}
