/**
 * requireSiteAdmin — Hono middleware for the apex /admin/* API. Checks Host
 * classification (must be apex), verifies bm_site_session cookie, loads the
 * site admin into `c.var.siteAdmin`. Returns 404 on wrong host (don't leak
 * the API surface), 401 when no/invalid session.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getSiteAdminById } from "@bulletinmail/db";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import {
  readSiteCookieFromHeader,
  verifySiteSessionCookie,
} from "../../lib/site-session.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export const requireSiteAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const host = c.req.header("Host") ?? "";
  if (classifyHost(host, c.var.config).kind !== "apex") {
    return c.text("Not found", 404);
  }
  const siteAdmin = await loadSiteAdminFromSession(c);
  if (!siteAdmin) return c.json({ error: "unauthorized" }, 401);
  c.set("siteAdmin", siteAdmin);
  await next();
};

async function loadSiteAdminFromSession(c: Ctx) {
  const secret = c.env.ADMIN_API_JWT_SECRET;
  if (!secret) return null;
  const cookie = readSiteCookieFromHeader(c.req.header("Cookie"));
  if (!cookie) return null;
  const payload = await verifySiteSessionCookie(cookie, secret);
  if (!payload) return null;
  return getSiteAdminById(c.env.DB, payload.siteAdminId);
}
