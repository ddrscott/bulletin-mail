/**
 * Tests for the tenant-facing docs page — <tenant>.<apex>/docs.
 *
 * Approach mirrors wiki-activity-route.test.ts: mount the route on a bare
 * Hono app with a minimal D1 mock. A trailing catch-all stands in for the
 * ASSETS fallthrough so we can assert when the route declines (next()).
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountTenantDocs } from "../server/routes/tenant-docs.js";
import type { AppVariables, Env } from "../server/types.js";
import type { InstanceConfig } from "@bulletinmail/shared";

const APEX = "example.org";
const TENANT_SLUG = "demo";
const TENANT_HOST = `${TENANT_SLUG}.${APEX}`;

const baseConfig: InstanceConfig = {
  apexDomain: APEX,
  productName: "Example Lists",
  productNameShort: "Lists",
  tagline: "...",
  supportAddress: "support",
  abuseAddress: "abuse",
  dmarcAddress: "dmarc",
  noreplyAddress: "noreply",
  unsubscribeAddressPrefix: "unsubscribe+",
  archiveUrlTemplate: "https://example.org/g/{tenant}/{group}",
  unsubscribeUrlTemplate: "https://example.org/u/{token}",
  additionalReservedSlugs: [],
  minSlugLength: 3,
  maxSlugLength: 40,
  defaultDailyMessageLimitPerTenant: 1000,
  defaultMaxRecipientsPerGroup: 500,
  operator: { legalName: "Example Org", mailingAddress: "...", contactUrl: "..." },
  mailSubdomain: null,
  ai: { dailyGenerationCap: 20, textModel: "@cf/test/text-model", imageModel: "@cf/test/image-model" },
  features: {
    byoDomainEnabled: false, publicArchivesAllowed: true, signupSelfService: false, singleTenant: false,
    ai: { promoteToWiki: false, wikiAutogen: false, wikiHeroImages: false },
  },
};

const TENANT_ROW = {
  id: "t_demo",
  slug: TENANT_SLUG,
  display_name: "Demo Org",
  byo_domain: null,
  plan: "free",
  created_at: 0,
  status: "active",
};

function makeD1(opts: { tenantStatus?: string | null } = {}): D1Database {
  const status = opts.tenantStatus === undefined ? "active" : opts.tenantStatus;
  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>() {
        if (/FROM tenants WHERE slug/.test(sql) && bound[0] === TENANT_SLUG && status !== null) {
          return { ...TENANT_ROW, status } as unknown as T;
        }
        return null;
      },
      async all<T>() {
        return { results: [] as T[] } as { results: T[] };
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

function buildApp(d1: D1Database, config: InstanceConfig = baseConfig) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });
  mountTenantDocs(app);
  // Stand-in for the ASSETS fallthrough in server/index.ts.
  app.all("*", (c) => c.text("assets-fallthrough", 418));
  const env = { DB: d1 } as unknown as Env;
  return { app, env };
}

function get(state: ReturnType<typeof buildApp>, host: string, path: string): Promise<Response> {
  return Promise.resolve(state.app.fetch(
    new Request(`https://${host}${path}`, { headers: { Host: host } }),
    state.env,
  ));
}

describe("GET /docs on a tenant subdomain", () => {
  it("renders the tenant getting-started page with real URLs", async () => {
    const state = buildApp(makeD1());
    const res = await get(state, TENANT_HOST, "/docs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Demo Org");
    expect(body).toContain(`https://${TENANT_HOST}/admin`);
    expect(body).toContain(`https://${TENANT_HOST}/join/`);
    expect(body).toContain(`https://${TENANT_HOST}/archive`);
    // Points to the full docs on the apex, not a copy.
    expect(body).toContain(`https://${APEX}/docs/how-to/tenant-admin/`);
    // Operator material is omitted.
    expect(body).not.toContain("self-host/");
    expect(body).not.toContain("wrangler");
  });

  it("serves the same page at /docs/ (trailing slash)", async () => {
    const state = buildApp(makeD1());
    const res = await get(state, TENANT_HOST, "/docs/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Demo Org");
  });

  it("301-redirects deep /docs/* paths to the apex docs", async () => {
    const state = buildApp(makeD1());
    const res = await get(state, TENANT_HOST, "/docs/how-to/self-host/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${APEX}/docs/how-to/self-host/`);
  });

  it("404s for an unknown tenant slug", async () => {
    const state = buildApp(makeD1({ tenantStatus: null }));
    const res = await get(state, TENANT_HOST, "/docs");
    expect(res.status).toBe(404);
  });

  it("404s for a suspended tenant", async () => {
    const state = buildApp(makeD1({ tenantStatus: "suspended" }));
    const res = await get(state, TENANT_HOST, "/docs");
    expect(res.status).toBe(404);
  });

  it("declines on the apex so the full docs tree is served", async () => {
    const state = buildApp(makeD1());
    const res = await get(state, APEX, "/docs");
    expect(res.status).toBe(418);
  });

  it("declines entirely in single-tenant mode", async () => {
    const config: InstanceConfig = {
      ...baseConfig,
      features: { ...baseConfig.features, singleTenant: true },
    };
    const state = buildApp(makeD1(), config);
    // In single-tenant mode the apex classifies as the tenant host.
    const res = await get(state, APEX, "/docs");
    expect(res.status).toBe(418);
  });
});
