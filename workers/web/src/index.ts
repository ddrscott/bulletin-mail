/**
 * Web Worker — single HTTP entry for the whole instance.
 *
 * Pattern (mirrors relaytty.com — see docs/explanation/http-routing.md):
 *   1. wrangler.toml declares one route: `*<apex>/*` matches apex AND every
 *      subdomain. There is no per-subdomain config to maintain.
 *   2. This handler classifies the request by Host (apex / admin / tenant)
 *      and dispatches.
 *   3. Apex-only routes MUST check the host and `return next()` for
 *      subdomain traffic — otherwise a per-tenant URL silently inherits the
 *      apex response (the relaytty `/assets/*` lesson, CLAUDE.md there).
 */

import { Hono } from "hono";
import { loadFromEnv, type InstanceConfig } from "@bulletinmail/shared";
import type { AppVariables, Env } from "./types.js";
import { mountUnsub } from "./routes/unsub.js";
import { mountConfirm } from "./routes/confirm.js";
import { mountBounce } from "./routes/bounce.js";
import { mountArchive } from "./routes/archive.js";
import { mountTenant } from "./routes/tenant.js";
import { mountAdmin } from "./routes/admin/index.js";

// Re-export the Durable Object class so Cloudflare's runtime sees it on this
// Worker — the binding `WIKI` in wrangler.toml maps to this class name.
export { TenantWikiDO } from "./wiki/do.js";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Load + attach InstanceConfig once per request. Cheap (string parsing only).
app.use("*", async (c, next) => {
  const config: InstanceConfig = loadFromEnv(
    c.env as unknown as Record<string, unknown>,
  );
  c.set("config", config);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

// One-click unsubscribe — must work on apex (RFC 8058 URL is on the apex).
// Defined explicitly (not host-gated) because the URL is always the apex.
mountUnsub(app);

// Double-opt-in confirmation — companion to /u/:token, lives on the apex.
mountConfirm(app);

// Bounce webhook — apex/api/bounce-events. POST only.
mountBounce(app);

// Apex archive: /g/:tenant/:group (Phase 2). Apex-only.
mountArchive(app);

// Admin app + API at app.<apex>/* — magic-link auth + members CRUD (Phase 2).
mountAdmin(app);

// Tenant subdomains: <tenant>.<apex>/* — currently redirect to apex archive,
// future: serve the per-tenant archive landing. Phase 2.
mountTenant(app);

// Fallback. Apex marketing + docs are served by `bulletinmail-docs` (Astro
// Starlight, Workers Assets). Anything that reaches this Worker without
// matching a specific route is either:
//   - an apex path under our narrow routes (/u/*, /g/*, /api/*, /health) that
//     nothing inside Hono claimed → 404;
//   - a tenant subdomain path we don't yet handle → 404;
//   - a Host-header spoof → 404.
app.all("*", (c) => c.text("Not found", 404));

export default app;
