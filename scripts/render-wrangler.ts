#!/usr/bin/env -S npx tsx
/**
 * render-wrangler — emit `wrangler.generated.toml` for each Worker from the
 * active instance overlay.
 *
 * Reads:
 *   - deployments/<instance>/instance.config.json
 *   - workers/<name>/wrangler.toml   (the committed file; [vars] block is
 *     treated as a template and overwritten)
 *
 * Writes:
 *   - workers/<name>/wrangler.generated.toml
 *
 * What it substitutes:
 *   - [vars] block: rebuilt entirely from instance.config.json
 *   - routes block (web worker only): apex domain
 *
 * What it does NOT substitute:
 *   - Cloudflare resource handles (D1 database_id, R2 bucket_name, queue
 *     names) come from `deployments/<instance>/cloudflare-resources.json`.
 *     They're substituted into the placeholders left in the source
 *     wrangler.toml (e.g. PLACEHOLDER_LOCAL_DEV → real database_id). The
 *     resources file is account-specific but not secret; commit it alongside
 *     instance.config.json in the overlay.
 *
 * Convention: in every Worker's wrangler.toml, the [vars] block must be the
 * last section. This script truncates from "\n[vars]" to EOF and appends the
 * regenerated block.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const instanceIdx = args.indexOf("--instance");
if (instanceIdx === -1 || !args[instanceIdx + 1]) {
  console.error("Usage: render-wrangler --instance <apex>");
  process.exit(2);
}
const instance = args[instanceIdx + 1]!;

const configPath = join("deployments", instance, "instance.config.json");
if (!existsSync(configPath)) {
  console.error(`No config at ${configPath}`);
  process.exit(2);
}

type InstanceOverlay = {
  apexDomain: string;
  productName: string;
  productNameShort: string;
  tagline: string;
  supportAddress?: string;
  abuseAddress?: string;
  dmarcAddress?: string;
  noreplyAddress?: string;
  unsubscribeAddressPrefix?: string;
  archiveUrlTemplate: string;
  unsubscribeUrlTemplate: string;
  additionalReservedSlugs?: string[];
  minSlugLength?: number;
  maxSlugLength?: number;
  defaultDailyMessageLimitPerTenant?: number;
  defaultMaxRecipientsPerGroup?: number;
  operator: { legalName: string; mailingAddress: string; contactUrl: string };
  features?: {
    byoDomainEnabled?: boolean;
    publicArchivesAllowed?: boolean;
    signupSelfService?: boolean;
  };
};

const config = JSON.parse(readFileSync(configPath, "utf8")) as InstanceOverlay;

type CloudflareResources = {
  account_id?: string;
  d1?: Record<string, { database_name: string; database_id: string }>;
};

const resourcesPath = join("deployments", instance, "cloudflare-resources.json");
const resources: CloudflareResources = existsSync(resourcesPath)
  ? (JSON.parse(readFileSync(resourcesPath, "utf8")) as CloudflareResources)
  : {};
if (!existsSync(resourcesPath)) {
  console.warn(
    `note: no ${resourcesPath} — placeholder D1/R2/Queue handles will remain in output`,
  );
}

const tomlStr = (s: string | number | boolean): string => JSON.stringify(String(s));

function renderVarsBlock(): string {
  const required: Array<[string, string | number | boolean]> = [
    ["INSTANCE_APEX_DOMAIN", config.apexDomain],
    ["INSTANCE_PRODUCT_NAME", config.productName],
    ["INSTANCE_PRODUCT_NAME_SHORT", config.productNameShort],
    ["INSTANCE_TAGLINE", config.tagline],
    ["INSTANCE_ARCHIVE_URL", config.archiveUrlTemplate],
    ["INSTANCE_UNSUB_URL", config.unsubscribeUrlTemplate],
    ["INSTANCE_OPERATOR_LEGAL_NAME", config.operator.legalName],
    ["INSTANCE_OPERATOR_MAILING_ADDRESS", config.operator.mailingAddress],
    ["INSTANCE_OPERATOR_CONTACT_URL", config.operator.contactUrl],
  ];
  const optional: Array<[string, string | number | boolean | undefined]> = [
    ["INSTANCE_SUPPORT_ADDRESS", config.supportAddress],
    ["INSTANCE_ABUSE_ADDRESS", config.abuseAddress],
    ["INSTANCE_DMARC_ADDRESS", config.dmarcAddress],
    ["INSTANCE_NOREPLY_ADDRESS", config.noreplyAddress],
    ["INSTANCE_UNSUB_PREFIX", config.unsubscribeAddressPrefix],
    ["INSTANCE_MIN_SLUG_LENGTH", config.minSlugLength],
    ["INSTANCE_MAX_SLUG_LENGTH", config.maxSlugLength],
    ["INSTANCE_DEFAULT_DAILY_MSG_LIMIT", config.defaultDailyMessageLimitPerTenant],
    ["INSTANCE_DEFAULT_MAX_RECIPIENTS", config.defaultMaxRecipientsPerGroup],
    ["INSTANCE_FEATURE_BYO_DOMAIN", config.features?.byoDomainEnabled],
    ["INSTANCE_FEATURE_PUBLIC_ARCHIVES", config.features?.publicArchivesAllowed],
    ["INSTANCE_FEATURE_SIGNUP_SELF_SERVICE", config.features?.signupSelfService],
  ];
  const reserved = config.additionalReservedSlugs ?? [];
  if (reserved.length > 0) {
    optional.push(["INSTANCE_RESERVED_SLUGS", reserved.join(",")]);
  }

  const lines = ["[vars]"];
  for (const [key, value] of required) {
    lines.push(`${key} = ${tomlStr(value)}`);
  }
  for (const [key, value] of optional) {
    if (value === undefined) continue;
    lines.push(`${key} = ${tomlStr(value)}`);
  }
  return lines.join("\n") + "\n";
}

type WorkerEntry = {
  /** Friendly id used in log lines and the routes-rewrite switch. */
  name: string;
  /** Directory containing wrangler.toml, relative to repo root. */
  dir: string;
  /** True if [vars] should be rendered for this worker (false for the docs site). */
  hasVars: boolean;
};

const WORKERS: WorkerEntry[] = [
  { name: "inbound", dir: "workers/inbound", hasVars: true },
  { name: "sender", dir: "workers/sender", hasVars: true },
  { name: "web", dir: "apps/web", hasVars: true },
];

for (const w of WORKERS) {
  const srcPath = join(w.dir, "wrangler.toml");
  if (!existsSync(srcPath)) {
    console.warn(`skip ${w.name}: no source wrangler.toml`);
    continue;
  }

  let src = readFileSync(srcPath, "utf8");

  // Route substitution. Each worker carries the routing strategy it wants;
  // we only swap the apex token inside whatever it declared. The web Worker
  // has multiple narrow routes plus a wildcard catch-all; the docs Worker
  // has the apex catch-all; everything else has no routes.
  if (/routes\s*=\s*\[[\s\S]*?\]/.test(src)) {
    src = src.replace(/routes\s*=\s*\[([\s\S]*?)\]/, (_match, inner: string) => {
      // Replace literal `example.org` (template placeholder) with the real apex.
      const updated = inner.replace(/example\.org/g, config.apexDomain);
      return `routes = [${updated}]`;
    });
  }

  if (w.hasVars) {
    // Truncate the existing [vars] block (must be the last section per convention).
    src = src.replace(/\n\[vars\][\s\S]*$/, "\n");
    // Trim trailing whitespace, then append the freshly rendered vars with a
    // blank line separator from the preceding section.
    src = src.replace(/\s+$/, "\n") + "\n" + renderVarsBlock();
  }

  // Substitute Cloudflare resource handles into the [[d1_databases]] /
  // [[r2_buckets]] / [[queues.*]] blocks.
  for (const [binding, info] of Object.entries(resources.d1 ?? {})) {
    const re = new RegExp(
      `(\\[\\[d1_databases\\]\\][\\s\\S]*?binding = "${binding}"[\\s\\S]*?database_id = )"PLACEHOLDER_LOCAL_DEV"`,
      "g",
    );
    src = src.replace(re, `$1"${info.database_id}"`);
  }

  const outPath = join(w.dir, "wrangler.generated.toml");
  writeFileSync(outPath, src);
  console.log(`wrote ${outPath}`);
}
