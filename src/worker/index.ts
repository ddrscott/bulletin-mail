/**
 * Web Worker — single HTTP entry for the whole instance.
 *
 * Pattern (mirrors relaytty.com — see docs/explanation/http-routing.md):
 *   1. wrangler.toml declares two routes: `<apex>/*` and `*.<apex>/*` cover
 *      apex AND every subdomain.
 *   2. This handler classifies the request by Host (apex / tenant) and
 *      dispatches. Apex-only routes return next() for subdomain traffic.
 *   3. Anything not matched by a Hono route falls through to env.ASSETS
 *      for static-asset serving (docs under /docs/*, admin SPA at /admin/*).
 *
 * Post-consolidation note: site admin and docs both live on the apex
 * (site admin at /admin/*, docs at /docs/*, landing at /). The separate
 * `app.<apex>` admin host was collapsed into the apex; classifyHost no
 * longer has an "admin" kind.
 */

import { Hono } from "hono";
import { loadFromEnv, classifyHost, type InstanceConfig } from "@bulletinmail/shared";
import type { AppVariables, Env } from "./types.js";
import { mountLanding } from "./routes/landing.js";
import { mountUnsub } from "./routes/unsub.js";
import { mountConfirm } from "./routes/confirm.js";
import { mountContact } from "./routes/contact.js";
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

// Apex landing page — broadsheet hero at `/`. Host-gated to apex inside.
mountLanding(app);

// One-click unsubscribe — must work on apex (RFC 8058 URL is on the apex).
mountUnsub(app);

// Double-opt-in confirmation — companion to /u/:token, lives on the apex.
mountConfirm(app);

// Apex contact form — posts to env.DISCORD_WEBHOOK. No JS, server-rendered.
mountContact(app);

// Bounce webhook — apex/api/bounce-events. POST only.
mountBounce(app);

// Apex archive: /g/:tenant/:group (Phase 2). Apex-only.
mountArchive(app);

// Admin auth + CRUD endpoints (apex for site admin, tenant subdomain for
// tenant admin). The static SPA at /admin/* is served by the ASSETS
// fallthrough below — this mount only registers JSON/HTML auth endpoints.
mountAdmin(app);

// Tenant subdomains: <tenant>.<apex>/* — wiki + /join, /api/wiki, /auth/*.
mountTenant(app);

// Static-asset fallthrough. Anything unmatched on apex or tenant subdomains
// goes to the [assets] binding, which serves:
//   /docs/*        Astro Starlight build
//   /admin/*       admin SPA (same files on apex and tenant subdomains —
//                  the SPA's hash routing + /api/me determine context)
//   /_astro/*      Astro JS/CSS bundles
//   /pagefind/*    docs search index
//   /favicon.svg
// Unknown hosts (spoofed Host header) get 404 — never expose ASSETS to them.
app.all("*", async (c) => {
  const host = c.req.header("Host") ?? "";
  const kind = classifyHost(host, c.var.config).kind;
  if (kind === "apex" || kind === "tenant") {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("Not found", 404);
});

export default app;
