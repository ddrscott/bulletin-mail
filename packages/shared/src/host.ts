/**
 * Parse the HTTP Host header into (tenantSlug, kind).
 *
 * BulletinMail follows the same single-Worker / wildcard-route model as
 * relaytty.com: one Worker handles *all* HTTP traffic for the apex and every
 * subdomain. Route dispatch then keys off the Host header.
 *
 * Examples (apex = "example.org", adminDomain = "app.example.org"):
 *
 *   "example.org"                → { kind: "apex" }
 *   "example.org:8787"           → { kind: "apex" }   (port stripped)
 *   "app.example.org"            → { kind: "admin" }
 *   "firstpresby.example.org"    → { kind: "tenant", slug: "firstpresby" }
 *   "x.y.example.org"            → { kind: "unknown" } (multi-level subdomain)
 *   "evil.com"                   → { kind: "unknown" } (wrong apex)
 *
 * Returns "unknown" — not null — so callers must explicitly handle the case.
 */

export type HostKind =
  | { kind: "apex" }
  | { kind: "admin" }
  | { kind: "tenant"; slug: string }
  | { kind: "unknown" };

export type HostConfig = {
  apexDomain: string;
  adminDomain: string;
};

export function classifyHost(host: string, config: HostConfig): HostKind {
  const hostname = (host.split(":")[0] ?? "").toLowerCase();
  if (!hostname) return { kind: "unknown" };

  if (hostname === config.apexDomain) return { kind: "apex" };
  if (hostname === config.adminDomain) return { kind: "admin" };

  const suffix = "." + config.apexDomain;
  if (!hostname.endsWith(suffix)) return { kind: "unknown" };

  const subdomain = hostname.slice(0, -suffix.length);
  // Reject multi-level subdomains (e.g. "x.y.<apex>") — tenants are flat.
  if (subdomain.length === 0 || subdomain.includes(".")) return { kind: "unknown" };

  return { kind: "tenant", slug: subdomain };
}

/**
 * Convenience: return the tenant slug or null. Use classifyHost() when you
 * need to distinguish apex vs admin vs unknown.
 */
export function extractTenantSlug(host: string, config: HostConfig): string | null {
  const result = classifyHost(host, config);
  return result.kind === "tenant" ? result.slug : null;
}
