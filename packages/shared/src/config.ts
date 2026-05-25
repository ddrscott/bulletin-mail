/**
 * InstanceConfig — every per-deployment value lives here.
 *
 * The OSS distribution model (PRD §19) requires that all per-instance values
 * (apex domain, product name, support addresses, archive URL template,
 * reserved-subdomain extras, etc.) be configurable. Generic code in
 * workers/, packages/, cli/, apps/ must never reference any of these values
 * literally — they must come from a loaded InstanceConfig.
 *
 * Sources, in order of precedence:
 *   1. Runtime env vars (`env.INSTANCE_*`) injected by Wrangler from
 *      `wrangler.generated.toml`, rendered from `instance.config.json` at
 *      deploy time by `scripts/render-wrangler.ts`.
 *   2. `instance.config.local.json` at repo root for local dev (gitignored).
 *   3. `deployments/<apex>/instance.config.json` — the committed overlay.
 *   4. `defaults` from this file — only for fields with a sensible default.
 *
 * See PRD §20 for the canonical manifest.
 */

export type InstanceConfig = {
  // Identity
  apexDomain: string;
  adminDomain: string;
  productName: string;
  productNameShort: string;
  tagline: string;

  // System addresses (local-parts; combined with apexDomain at runtime)
  supportAddress: string;
  abuseAddress: string;
  dmarcAddress: string;
  noreplyAddress: string;
  unsubscribeAddressPrefix: string;

  // URL templates: {tenant}, {group}, {token}, {apex} are substituted.
  archiveUrlTemplate: string;
  unsubscribeUrlTemplate: string;
  adminUrl: string;

  // Slug policy (merged with packages/shared/src/slug.ts BASE_RESERVED_SLUGS)
  additionalReservedSlugs: readonly string[];
  minSlugLength: number;
  maxSlugLength: number;

  // Rate limits
  defaultDailyMessageLimitPerTenant: number;
  defaultMaxRecipientsPerGroup: number;

  // Operator metadata (footers, abuse reports, DMARC contact)
  operator: {
    legalName: string;
    mailingAddress: string;
    contactUrl: string;
  };

  // Feature toggles — keep this list small
  features: {
    byoDomainEnabled: boolean;
    publicArchivesAllowed: boolean;
    signupSelfService: boolean;
  };
};

/**
 * Defaults applied when an operator omits an optional field. Required fields
 * (apexDomain, productName, ...) have no default — a missing one is a fatal
 * config error caught at Worker startup.
 */
export const defaults = {
  supportAddress: "support",
  abuseAddress: "abuse",
  dmarcAddress: "dmarc",
  noreplyAddress: "noreply",
  unsubscribeAddressPrefix: "unsubscribe+",

  additionalReservedSlugs: [] as readonly string[],
  minSlugLength: 3,
  maxSlugLength: 40,

  defaultDailyMessageLimitPerTenant: 1000,
  defaultMaxRecipientsPerGroup: 500,

  features: {
    byoDomainEnabled: false,
    publicArchivesAllowed: true,
    signupSelfService: false,
  },
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Worker-side env reader. Wrangler injects each config field as a flat string
 * variable in [vars]; this helper parses and assembles them into a typed
 * InstanceConfig. Called once per Worker invocation — strings only, no I/O.
 */
export function loadFromEnv(env: Record<string, unknown>): InstanceConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new ConfigError(`Required instance config var '${k}' is missing or empty`);
    }
    return v;
  };
  const stringOr = (k: string, fallback: string): string => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 ? v : fallback;
  };
  const numberOr = (k: string, fallback: number): number => {
    const v = env[k];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`Var '${k}' is not numeric: ${String(v)}`);
    return n;
  };
  const boolOr = (k: string, fallback: boolean): boolean => {
    const v = env[k];
    if (v === undefined) return fallback;
    return v === "true" || v === "1";
  };
  const csv = (k: string): readonly string[] => {
    const v = env[k];
    if (typeof v !== "string" || v.length === 0) return [];
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  };

  return {
    apexDomain: required("INSTANCE_APEX_DOMAIN"),
    adminDomain: required("INSTANCE_ADMIN_DOMAIN"),
    productName: required("INSTANCE_PRODUCT_NAME"),
    productNameShort: required("INSTANCE_PRODUCT_NAME_SHORT"),
    tagline: required("INSTANCE_TAGLINE"),

    supportAddress: stringOr("INSTANCE_SUPPORT_ADDRESS", defaults.supportAddress),
    abuseAddress: stringOr("INSTANCE_ABUSE_ADDRESS", defaults.abuseAddress),
    dmarcAddress: stringOr("INSTANCE_DMARC_ADDRESS", defaults.dmarcAddress),
    noreplyAddress: stringOr("INSTANCE_NOREPLY_ADDRESS", defaults.noreplyAddress),
    unsubscribeAddressPrefix: stringOr(
      "INSTANCE_UNSUB_PREFIX",
      defaults.unsubscribeAddressPrefix,
    ),

    archiveUrlTemplate: required("INSTANCE_ARCHIVE_URL"),
    unsubscribeUrlTemplate: required("INSTANCE_UNSUB_URL"),
    adminUrl: required("INSTANCE_ADMIN_URL"),

    additionalReservedSlugs: csv("INSTANCE_RESERVED_SLUGS"),
    minSlugLength: numberOr("INSTANCE_MIN_SLUG_LENGTH", defaults.minSlugLength),
    maxSlugLength: numberOr("INSTANCE_MAX_SLUG_LENGTH", defaults.maxSlugLength),

    defaultDailyMessageLimitPerTenant: numberOr(
      "INSTANCE_DEFAULT_DAILY_MSG_LIMIT",
      defaults.defaultDailyMessageLimitPerTenant,
    ),
    defaultMaxRecipientsPerGroup: numberOr(
      "INSTANCE_DEFAULT_MAX_RECIPIENTS",
      defaults.defaultMaxRecipientsPerGroup,
    ),

    operator: {
      legalName: required("INSTANCE_OPERATOR_LEGAL_NAME"),
      mailingAddress: required("INSTANCE_OPERATOR_MAILING_ADDRESS"),
      contactUrl: required("INSTANCE_OPERATOR_CONTACT_URL"),
    },

    features: {
      byoDomainEnabled: boolOr(
        "INSTANCE_FEATURE_BYO_DOMAIN",
        defaults.features.byoDomainEnabled,
      ),
      publicArchivesAllowed: boolOr(
        "INSTANCE_FEATURE_PUBLIC_ARCHIVES",
        defaults.features.publicArchivesAllowed,
      ),
      signupSelfService: boolOr(
        "INSTANCE_FEATURE_SIGNUP_SELF_SERVICE",
        defaults.features.signupSelfService,
      ),
    },
  };
}

// URL + address helpers — the only correct way to derive an instance-specific
// string from generic code. The interpolation set is intentionally narrow
// ({tenant}, {group}, {token}, {apex}) so templates can't be abused as a
// general expression language.

export function archiveUrl(
  config: InstanceConfig,
  tenant: string,
  group: string,
): string {
  return interpolate(config.archiveUrlTemplate, {
    tenant,
    group,
    apex: config.apexDomain,
  });
}

export function unsubscribeUrl(config: InstanceConfig, token: string): string {
  return interpolate(config.unsubscribeUrlTemplate, {
    token,
    apex: config.apexDomain,
  });
}

export function unsubscribeMailto(config: InstanceConfig, token: string): string {
  return `${config.unsubscribeAddressPrefix}${token}@${config.apexDomain}`;
}

export type SystemAddressKind = "support" | "abuse" | "dmarc" | "noreply";

export function systemAddress(config: InstanceConfig, kind: SystemAddressKind): string {
  const localPart = {
    support: config.supportAddress,
    abuse: config.abuseAddress,
    dmarc: config.dmarcAddress,
    noreply: config.noreplyAddress,
  }[kind];
  return `${localPart}@${config.apexDomain}`;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new ConfigError(
        `URL template references unknown placeholder '{${key}}': ${template}`,
      );
    }
    return value;
  });
}
