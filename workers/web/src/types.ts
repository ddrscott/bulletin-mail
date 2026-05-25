import type { InstanceConfig } from "@bulletinmail/shared";
import type { Admin, SiteAdmin, Tenant } from "@bulletinmail/db";

/**
 * Worker env bindings. INSTANCE_* string vars feed loadFromEnv() to produce
 * the typed InstanceConfig on each request.
 */
export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;               // for admin magic-link emails
  ASSETS: Fetcher;                // apps/admin/dist (Workers Assets)
  WIKI: DurableObjectNamespace;   // TenantWikiDO, one instance per tenant
  WIKI_R2: R2Bucket;              // compiled HTML + uploaded images
  UNSUB_TOKEN_PEPPER: string;     // `wrangler secret put`
  ADMIN_API_JWT_SECRET: string;   // `wrangler secret put`
  [varName: string]: unknown;
}

/** Variables we attach to the Hono context via c.set / c.get. */
export type AppVariables = {
  config: InstanceConfig;
  /** Set by requireTenantAdmin after verifying bm_tenant_session. */
  admin?: Admin;
  /** Tenant matched from Host header — set by requireTenantAdmin. */
  tenant?: Tenant;
  /** Set by requireSiteAdmin after verifying bm_site_session. */
  siteAdmin?: SiteAdmin;
};
