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
 * Single-tenant mode (config.features.singleTenant = true):
 *
 *   "example.org"                → { kind: "tenant", slug: <singleTenantSlug> }
 *
 * The single-tenant flag remaps the apex itself into the tenant namespace
 * so every existing wiki / admin / /join / /auth route fires at the apex
 * unchanged. The slug equals `config.mailSubdomain` (default "mail") — the
 * same value used to build mail addresses, so the slug doubles as the DNS
 * label for inbound + outbound mail. The marketing landing page is gated
 * off by the mount layer (see server/index.ts), not here.
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
  /** Drives the single-tenant slug: in single-tenant mode the apex remaps to
   * `{ kind: "tenant", slug: mailSubdomain ?? "mail" }`. Equals the DNS
   * label that hosts mail, so slug + mail host stay in sync. Ignored in
   * multi-tenant mode. */
  mailSubdomain?: string | null;
};

const DEFAULT_SINGLE_TENANT_SLUG = "mail";

function isSingleTenant(config: HostConfig): boolean {
  return Boolean(config.singleTenant ?? config.features?.singleTenant);
}

function singleTenantSlug(config: HostConfig): string {
  return config.mailSubdomain ?? DEFAULT_SINGLE_TENANT_SLUG;
}

export function classifyHost(host: string, config: HostConfig): HostKind {
  const hostname = (host.split(":")[0] ?? "").toLowerCase();
  if (!hostname) return { kind: "unknown" };

  if (hostname === config.apexDomain) {
    return isSingleTenant(config)
      ? { kind: "tenant", slug: singleTenantSlug(config) }
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
 * Web origin for a tenant's pages (wiki, archive, /t/<id> permalinks). In
 * multi-tenant mode that's the tenant subdomain; in single-tenant mode the
 * apex itself serves the tenant (the slug only labels the MAIL subdomain),
 * so links must point at the apex. Used by digest emails and anything else
 * that builds absolute tenant URLs outside a request context.
 */
export function tenantWebBase(config: HostConfig, tenantSlug: string): string {
  if (isSingleTenant(config) && tenantSlug === singleTenantSlug(config)) {
    return `https://${config.apexDomain}`;
  }
  return `https://${tenantSlug}.${config.apexDomain}`;
}

/**
 * Convenience: return the tenant slug or null. Use classifyHost() when you
 * need to distinguish apex vs tenant vs unknown.
 */
export function extractTenantSlug(host: string, config: HostConfig): string | null {
  const result = classifyHost(host, config);
  return result.kind === "tenant" ? result.slug : null;
}
