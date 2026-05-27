/**
 * Admin surface — mounted on the apex (post-collapse) and tenant subdomains.
 *
 * Post-consolidation:
 *   - Apex `/admin/*`     → site admin (operating the instance)
 *   - <tenant>.<apex>/admin/*  → tenant admin (managing one tenant)
 *
 * Each child mount uses middleware that gates on host kind (apex for site,
 * tenant for tenant). Auth routes do internal host-dispatch and respond
 * appropriately to each.
 *
 * Static SPA files at /admin/* are served by the [assets] binding via the
 * apex/tenant fallthrough in src/worker/index.ts — this module only registers
 * the JSON/API endpoints under /admin/auth/*, /admin/api/*, etc.
 */

import type { Hono } from "hono";
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
}
