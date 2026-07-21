import type { InstanceConfig, SearchIndex } from "@bulletinmail/shared";
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
  ATTACHMENTS: R2Bucket;          // message attachments (written by inbound)
  AI: Ai;                          // Workers AI binding — wiki edit summaries + search embeddings
  /**
   * Vectorize index for unified search (archive + wiki). OPTIONAL: only
   * bound when the instance enables features.searchEnabled. When absent the
   * /search UI hides and all indexing hooks no-op.
   */
  SEARCH_INDEX?: SearchIndex;
  UNSUB_TOKEN_PEPPER: string;     // `wrangler secret put`
  ADMIN_API_JWT_SECRET: string;   // `wrangler secret put`
  DISCORD_WEBHOOK: string;        // `wrangler secret put` — /contact form sink
  /**
   * Cloudflare Turnstile keys for admin sign-in bot protection. Both
   * env-gated and optional: when unset, the human check is bypassed (dev
   * mode). When both set, /api/auth/request requires a valid token. The
   * site key is public (served via /api/auth/config so the SPA can mount
   * the widget); the secret is a Worker secret.
   */
  TURNSTILE_SITE_KEY?: string;    // `wrangler secret put` (public-ok)
  TURNSTILE_SECRET_KEY?: string;  // `wrangler secret put`
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
