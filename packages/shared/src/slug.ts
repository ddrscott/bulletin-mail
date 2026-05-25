/**
 * Tenant slug validation.
 *
 * Tenants are real DNS subdomains, so the signup flow must reject any slug
 * that would collide with system or future-use subdomains. The effective
 * reserved set is the union of BASE_RESERVED_SLUGS (this file — applies to
 * every BulletinMail instance) and the operator's
 * InstanceConfig.additionalReservedSlugs.
 *
 * See PRD §6.
 */

import type { InstanceConfig } from "./config.js";

/**
 * Reserved subdomains that no tenant may claim. Applies to every BulletinMail
 * deployment. Operator-specific extras come from
 * InstanceConfig.additionalReservedSlugs.
 */
export const BASE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Web infra
  "www", "app", "api", "admin", "auth", "login", "account", "accounts",
  // Mail infra
  "mail", "smtp", "imap", "pop", "mx", "noreply", "postmaster",
  // Operator addresses
  "support", "help", "hello", "abuse", "dmarc", "security",
  // Common subdomains operators tend to want later
  "status", "blog", "docs", "dev", "staging", "test", "demo",
  "about", "billing", "pay", "marketing",
  // Privacy / safety reservations
  "public", "private", "system", "root", "cloudflare",
  // Could-mean-anything (avoid confusion with the product itself)
  "ml", "list", "lists", "group", "groups", "bulletin", "bulletins",
]);

const SLUG_PATTERN = /^[a-z][a-z0-9-]+[a-z0-9]$/;

export type SlugValidationResult =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

export type SlugPolicy = Pick<
  InstanceConfig,
  "minSlugLength" | "maxSlugLength" | "additionalReservedSlugs"
>;

/**
 * Validate a tenant slug against the policy in PRD §6.
 *
 * Pass the loaded InstanceConfig (or any object satisfying SlugPolicy) so
 * operator-specific reserved additions are honored.
 */
export function validateTenantSlug(input: string, policy: SlugPolicy): SlugValidationResult {
  const slug = input.trim().toLowerCase();

  if (slug.length < policy.minSlugLength) {
    return { ok: false, reason: `must be at least ${policy.minSlugLength} characters` };
  }
  if (slug.length > policy.maxSlugLength) {
    return { ok: false, reason: `must be at most ${policy.maxSlugLength} characters` };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      reason:
        "must start with a letter, end with a letter or digit, and contain only lowercase ASCII letters, digits, and hyphens",
    };
  }
  if (BASE_RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: `'${slug}' is reserved` };
  }
  for (const reserved of policy.additionalReservedSlugs) {
    if (reserved.toLowerCase() === slug) {
      return { ok: false, reason: `'${slug}' is reserved for this instance` };
    }
  }
  return { ok: true, slug };
}
