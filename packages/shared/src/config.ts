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
  productName: string;
  productNameShort: string;
  tagline: string;

  // System addresses (local-parts; combined with the mail host at runtime —
  // see mailHost() below, which respects mailSubdomain.)
  supportAddress: string;
  abuseAddress: string;
  dmarcAddress: string;
  noreplyAddress: string;
  unsubscribeAddressPrefix: string;

  /**
   * Optional DNS label that hosts mail (outbound From / inbound recipient
   * domain). When set, system addresses live at `<localPart>@<mailSubdomain>.<apex>`
   * instead of `<localPart>@<apex>`. The single-tenant deploy variant uses
   * this to keep mail on its own subdomain (default "mail") with its own
   * SPF/DKIM/DMARC surface, separate from the apex's web traffic. In single-
   * tenant mode the lone tenant's slug ALSO equals this value, so list
   * addresses become `<group>@<mailSubdomain>.<apex>`. In multi-tenant mode
   * this only affects system addresses; list addresses still use
   * `<group>@<tenant>.<apex>`.
   */
  mailSubdomain: string | null;

  // URL templates: {tenant}, {group}, {token}, {apex} are substituted.
  archiveUrlTemplate: string;
  unsubscribeUrlTemplate: string;

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

  /**
   * Workers AI tuning knobs. Only consulted when at least one features.ai.*
   * flag is on AND the deploy binds Workers AI (`env.AI`). Model ids are
   * config, not code, so operators can track Workers AI model deprecations
   * without a source change.
   */
  ai: {
    /** Max AI generation calls (text or image) per tenant per UTC day.
     *  Counted in D1 (`ai_usage`); callers refuse with a clear "limit
     *  reached" message once the cap is hit. */
    dailyGenerationCap: number;
    /** Text-generation model for promote-to-wiki and red-link autogen. */
    textModel: string;
    /** Text-to-image model for wiki hero images. */
    imageModel: string;
  };

  // Feature toggles — keep this list small
  features: {
    byoDomainEnabled: boolean;
    publicArchivesAllowed: boolean;
    signupSelfService: boolean;
    /**
     * LLM extras, each independently opt-in and default OFF — the only part
     * of the stack that can meaningfully consume paid resources, so they
     * ship dark. A flag being true is necessary but not sufficient: the
     * Worker must also have the `AI` binding, otherwise the features hide
     * entirely (no broken buttons). Zero Workers AI calls when off.
     */
    ai: {
      /** Promote a mail thread into an LLM-drafted wiki page (human-reviewed
       *  in the editor before saving — never auto-published). */
      promoteToWiki: boolean;
      /** Generate a draft page when an editor follows a red link. */
      wikiAutogen: boolean;
      /** Generate hero images for wiki pages (stored in R2). */
      wikiHeroImages: boolean;
    };
    /**
     * Single-tenant deployment mode. When true, the apex domain IS the
     * tenant — the wiki, /admin/, /join/, /auth/ serve from the apex root
     * with no tenant subdomain. The single tenant is identified by the
     * configured `mailSubdomain` (default "mail") so the slug doubles as the
     * DNS label for inbound + outbound mail. First signup creates the tenant
     * + admin atomically. Marketing landing + Astro docs build are skipped.
     * Reference deployment leaves this false; per-client single-org deploys
     * flip it on in their overlay.
     */
    singleTenant: boolean;
  };
};

/**
 * Default mail subdomain used in single-tenant deployments. The lone
 * tenant's slug equals this value (or whatever the operator overrides
 * via `mailSubdomain`), so all of: classifier remap on the apex, MIME
 * From addresses, inbound recipient resolution — all converge on the
 * same string.
 */
export const DEFAULT_SINGLE_TENANT_MAIL_SUBDOMAIN = "mail";

/**
 * Resolve the tenant slug used by the single-tenant deploy variant. Equals
 * config.mailSubdomain when set (so the slug doubles as the DNS label),
 * otherwise the default `"mail"`. Returns null in multi-tenant mode — the
 * concept doesn't apply.
 */
export function singleTenantSlug(config: {
  features: { singleTenant: boolean };
  mailSubdomain?: string | null;
}): string | null {
  if (!config.features.singleTenant) return null;
  return config.mailSubdomain ?? DEFAULT_SINGLE_TENANT_MAIL_SUBDOMAIN;
}

/**
 * The host used for outbound From / inbound recipient on system mail
 * (noreply, support, abuse, dmarc, unsubscribe mailtos). Returns
 * `<mailSubdomain>.<apex>` when set; the apex itself otherwise.
 */
export function mailHost(config: {
  apexDomain: string;
  mailSubdomain?: string | null;
}): string {
  return config.mailSubdomain
    ? `${config.mailSubdomain}.${config.apexDomain}`
    : config.apexDomain;
}

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

  ai: {
    dailyGenerationCap: 20,
    // Same model the wiki edit-summary feature already uses — fast, cheap,
    // ample context. Overridable per instance (INSTANCE_AI_TEXT_MODEL).
    textModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    imageModel: "@cf/black-forest-labs/flux-1-schnell",
  },

  features: {
    byoDomainEnabled: false,
    publicArchivesAllowed: true,
    signupSelfService: false,
    singleTenant: false,
    ai: {
      promoteToWiki: false,
      wikiAutogen: false,
      wikiHeroImages: false,
    },
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

    mailSubdomain: (() => {
      const v = env["INSTANCE_MAIL_SUBDOMAIN"];
      return typeof v === "string" && v.length > 0 ? v : null;
    })(),

    archiveUrlTemplate: required("INSTANCE_ARCHIVE_URL"),
    unsubscribeUrlTemplate: required("INSTANCE_UNSUB_URL"),

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

    ai: {
      dailyGenerationCap: numberOr(
        "INSTANCE_AI_DAILY_CAP",
        defaults.ai.dailyGenerationCap,
      ),
      textModel: stringOr("INSTANCE_AI_TEXT_MODEL", defaults.ai.textModel),
      imageModel: stringOr("INSTANCE_AI_IMAGE_MODEL", defaults.ai.imageModel),
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
      singleTenant: boolOr(
        "INSTANCE_FEATURE_SINGLE_TENANT",
        defaults.features.singleTenant,
      ),
      ai: {
        promoteToWiki: boolOr(
          "INSTANCE_FEATURE_AI_PROMOTE_TO_WIKI",
          defaults.features.ai.promoteToWiki,
        ),
        wikiAutogen: boolOr(
          "INSTANCE_FEATURE_AI_WIKI_AUTOGEN",
          defaults.features.ai.wikiAutogen,
        ),
        wikiHeroImages: boolOr(
          "INSTANCE_FEATURE_AI_WIKI_HERO_IMAGES",
          defaults.features.ai.wikiHeroImages,
        ),
      },
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
  return `${config.unsubscribeAddressPrefix}${token}@${mailHost(config)}`;
}

export type SystemAddressKind = "support" | "abuse" | "dmarc" | "noreply";

export function systemAddress(config: InstanceConfig, kind: SystemAddressKind): string {
  const localPart = {
    support: config.supportAddress,
    abuse: config.abuseAddress,
    dmarc: config.dmarcAddress,
    noreply: config.noreplyAddress,
  }[kind];
  return `${localPart}@${mailHost(config)}`;
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
