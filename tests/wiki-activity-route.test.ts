/**
 * Smoke tests for GET /activity — the cross-page wiki activity feed.
 *
 * Approach: mount mountWikiRoutes on a Hono app with hand-rolled mocks for
 * D1 + the WIKI Durable Object + the AI binding. The handler reads from
 * c.env and c.var.config so we only need to populate those.
 *
 * The full route also calls resolveTenantContext / getTenantBySlug — which
 * means D1 must answer "tenants WHERE slug" for the test host. We mock the
 * minimum surface (prepare → bind → first/all) the route exercises.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountWikiRoutes } from "../server/wiki/routes.js";
import type { AppVariables, Env } from "../server/types.js";
import type { InstanceConfig } from "@bulletinmail/shared";
import type { ActivityRow } from "../server/wiki/do.js";

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
  features: { byoDomainEnabled: false, publicArchivesAllowed: true, signupSelfService: false, singleTenant: false },
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

const ADMIN_ROW = {
  id: "a_admin",
  tenant_id: "t_demo",
  email: "alice@example.com",
  role: "admin",
  display_name: "Alice",
  created_at: 0,
};

/**
 * Minimal D1Database mock. The wiki route exercises two SQL paths in
 * this test:
 *   1. SELECT … FROM tenants WHERE slug = ?   (resolveTenantContext)
 *   2. SELECT … FROM admins WHERE id = ?      (resolveTenantContext +
 *                                              loadAuthorNameMap)
 * We dispatch on a substring match so the schema text isn't load-bearing.
 */
function makeD1(opts: { hasAdmin: boolean }): D1Database {
  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T>() {
        if (/FROM tenants WHERE slug/.test(sql) && bound[0] === TENANT_SLUG) {
          return TENANT_ROW as unknown as T;
        }
        if (/FROM admins WHERE id/.test(sql)) {
          return (opts.hasAdmin && bound[0] === ADMIN_ROW.id ? ADMIN_ROW : null) as unknown as T;
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

const ACTIVITY_FIXTURE: ActivityRow[] = [
  {
    version_id: "v0001abcdef",
    page_id: "p1",
    page_slug: "index",
    page_title: "Welcome",
    author_admin_id: ADMIN_ROW.id,
    note: null,
    summary: "Added a paragraph about Sunday school.",
    added_lines: 3,
    removed_lines: 1,
    created_at: Date.now() - 60_000,
  },
];

function makeWikiNamespace(): DurableObjectNamespace {
  const stub = {
    async fetch(url: string | URL): Promise<Response> {
      const u = typeof url === "string" ? new URL(url) : url;
      if (u.pathname === "/rpc/listRecentActivity") {
        return Response.json(ACTIVITY_FIXTURE);
      }
      return new Response("not found", { status: 404 });
    },
  };
  return {
    idFromName: () => ({ toString: () => "id" }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

type TestAppState = {
  app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  env: Env;
};

function buildApp(d1: D1Database): TestAppState {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  // Mirror server/index.ts: attach config before any route.
  app.use("*", async (c, next) => {
    c.set("config", baseConfig);
    await next();
  });
  mountWikiRoutes(app);
  // Hono treats the second arg to app.fetch() as the bindings object — we
  // pass it explicitly per request so tests can vary env per case.
  const env = {
    DB: d1,
    WIKI: makeWikiNamespace(),
    ADMIN_API_JWT_SECRET: "test-secret-1234567890",
    AI: { run: async () => ({ response: "n/a" }) } as unknown as Ai,
  } as unknown as Env;
  return { app, env };
}

async function callActivity(
  state: TestAppState,
  cookie?: string,
  accept = "application/json",
): Promise<Response> {
  const headers: Record<string, string> = {
    Host: TENANT_HOST,
    Accept: accept,
  };
  if (cookie) headers.Cookie = cookie;
  return state.app.fetch(
    new Request(`https://${TENANT_HOST}/activity`, { headers }),
    state.env,
  );
}

describe("GET /activity", () => {
  it("returns 401 to unauthenticated JSON callers", async () => {
    const app = buildApp(makeD1({ hasAdmin: false }));
    const res = await callActivity(app);
    expect(res.status).toBe(401);
  });

  it("returns 302 → /auth/sign-in for unauthenticated browser requests", async () => {
    const app = buildApp(makeD1({ hasAdmin: false }));
    const res = await callActivity(app, undefined, "text/html");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in");
    expect(location).toContain("return_to=%2Factivity");
  });

  it("returns 200 with the page title + summary to an authenticated admin", async () => {
    const { issueTenantSessionCookie, TENANT_COOKIE_NAME } =
      await import("../server/wiki/tenant-auth.js");
    const secret = "test-secret-1234567890";
    const value = await issueTenantSessionCookie(ADMIN_ROW.id, TENANT_ROW.id, secret);
    const app = buildApp(makeD1({ hasAdmin: true }));
    const res = await callActivity(app, `${TENANT_COOKIE_NAME}=${value}`, "text/html");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Welcome"); // page title
    expect(body).toContain("/wiki/index");
    expect(body).toContain("Added a paragraph about Sunday school.");
    // Delta is shown next to the AI summary (constraint: AI text never
    // appears without a deterministic signal next to it).
    expect(body).toContain("+3");
    expect(body).toContain("-1");
    expect(body).toContain("Alice"); // author display name
  });
});
