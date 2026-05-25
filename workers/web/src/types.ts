import type { InstanceConfig } from "@bulletinmail/shared";

/**
 * Worker env bindings. INSTANCE_* string vars feed loadFromEnv() to produce
 * the typed InstanceConfig on each request.
 */
export interface Env {
  DB: D1Database;
  UNSUB_TOKEN_PEPPER: string;     // `wrangler secret put`
  ADMIN_API_JWT_SECRET: string;   // `wrangler secret put` (Phase 2)
  [varName: string]: unknown;
}

/** Variables we attach to the Hono context via c.set / c.get. */
export type AppVariables = {
  config: InstanceConfig;
};
