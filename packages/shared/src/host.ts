/**
 * Parse the HTTP Host header into (tenantSlug, kind).
 *
 * BulletinMail follows the same single-Worker / wildcard-route model as
 * relaytty.com: one Worker handles *all* HTTP traffic for the apex and every
 * subdomain. Route dispatch then keys off the Host header.
 *
 * Multi-tenant (default) examples (apex = "example.org"):
 *
 *   "example.org"                → { kind: "apex" }
 *   "example.org:8787"           → { kind: "apex" }   (port stripped)
 *   "firstpresby.example.org"    → { kind: "tenant", slug: "firstpresby" }
 *   "x.y.example.org"            → { kind: "unknown" } (multi-level subdomain)
 *   "evil.com"                   → { kind: "unknown" } (wrong apex)
 *
 * Single-tenant mode (config.singleTenant = true):
 *
 *   "example.org"                → { kind: "tenant", slug: "main" }
 *
 * The single-tenant flag remaps the apex itself into the tenant namespace
 * so every existing wiki / admin / /join / /auth route fires at the apex
 * unchanged. The fixed slug "main" is exported as SINGLE_TENANT_SLUG from
 * config.ts. The marketing landing page is gated off by the mount layer
 * (see server/index.ts), not here.
 *
 * Returns "unknown" — not null — so callers must explicitly handle the case.
 */

export type HostKind =
  | { kind: "apex" }
  | { kind: "tenant"; slug: string }
  | { kind: "unknown" };

export type HostConfig = {
  apexDomain: string;
  /** When true, the apex itself is the tenant. See module docstring.
   * Accepts either the top-level shortcut or the nested
   * `features.singleTenant` shape used by InstanceConfig so that callers
   * can pass either form without an extra wrapper. */
  singleTenant?: boolean;
  features?: { singleTenant?: boolean };
};

/** Tenant slug used in single-tenant deployments. Kept here (not imported
 * from config.ts) so host.ts has no dependency cycle and stays a pure
 * string-classifier. config.ts re-exports the same constant under the
 * same name for app code to import. */
const SINGLE_TENANT_SLUG = "main";

function isSingleTenant(config: HostConfig): boolean {
  return Boolean(config.singleTenant ?? config.features?.singleTenant);
}

export function classifyHost(host: string, config: HostConfig): HostKind {
  const hostname = (host.split(":")[0] ?? "").toLowerCase();
  if (!hostname) return { kind: "unknown" };

  if (hostname === config.apexDomain) {
    return isSingleTenant(config)
      ? { kind: "tenant", slug: SINGLE_TENANT_SLUG }
      : { kind: "apex" };
  }

  const suffix = "." + config.apexDomain;
  if (!hostname.endsWith(suffix)) return { kind: "unknown" };

  const subdomain = hostname.slice(0, -suffix.length);
  // Reject multi-level subdomains (e.g. "x.y.<apex>") — tenants are flat.
  if (subdomain.length === 0 || subdomain.includes(".")) return { kind: "unknown" };

  return { kind: "tenant", slug: subdomain };
}

/**
 * Convenience: return the tenant slug or null. Use classifyHost() when you
 * need to distinguish apex vs tenant vs unknown.
 */
export function extractTenantSlug(host: string, config: HostConfig): string | null {
  const result = classifyHost(host, config);
  return result.kind === "tenant" ? result.slug : null;
}
