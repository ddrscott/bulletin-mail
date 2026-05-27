/**
 * Apex archive viewer — /g/:tenant/:group.
 *
 * Phase 2/3. Auth: member-only by default; public if the group has
 * `archive_visibility = 'public'` AND `config.features.publicArchivesAllowed`.
 *
 * See PRD §10 (V2 archive).
 *
 * IMPORTANT: apex-only. Must `return next()` for subdomain hosts so the
 * tenant catch-all picks them up.
 */

import type { Hono } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../types.js";

export function mountArchive(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/g/:tenant/:group", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "apex") return next();

    const _tenant = c.req.param("tenant");
    const _group = c.req.param("group");
    return c.text("Archive viewer not implemented (Phase 2)", 501);
  });
}
