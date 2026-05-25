# `InstanceConfig` reference

Per-deployment configuration for a BulletinMail instance. Lives at `deployments/<apex>/instance.config.json` and is loaded at Worker startup via `loadFromEnv` in `packages/shared/src/config.ts`. The JSON Schema is at `packages/shared/instance.config.schema.json`.

## Schema

### Identity

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apexDomain` | string (required) | — | Root domain serving the instance, e.g. `bulletinmail.org`. |
| `adminDomain` | string (required) | — | Host serving the admin app, e.g. `app.bulletinmail.org`. Must be a subdomain of `apexDomain`. |
| `productName` | string (required) | — | Display name, e.g. `"BulletinMail"`. Used in email subject prefixes, From-header decorations, and page titles. |
| `productNameShort` | string (required) | — | Short form, e.g. `"Bulletin"`. Used where space is tight. |
| `tagline` | string (required) | — | Marketing line shown on the apex landing and email footers. |

### System addresses

All values are local-parts (no `@<apex>`); combined with `apexDomain` at runtime.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `supportAddress` | string | `"support"` | Operator support contact. |
| `abuseAddress` | string | `"abuse"` | Abuse reports. |
| `dmarcAddress` | string | `"dmarc"` | DMARC aggregate / forensic report destination. |
| `noreplyAddress` | string | `"noreply"` | Default From local-part for system-generated mail. |
| `unsubscribeAddressPrefix` | string | `"unsubscribe+"` | Local-part prefix for one-click unsubscribe tokens. The full pattern is `<prefix><token>@<apex>`. |

### URL templates

Placeholders `{tenant}`, `{group}`, `{token}`, `{apex}` are interpolated at template-expansion time.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `archiveUrlTemplate` | string (required) | — | Per-group archive URL. Supports `{tenant}`, `{group}`, `{apex}`. |
| `unsubscribeUrlTemplate` | string (required) | — | RFC 8058 one-click URL. Supports `{token}`, `{apex}`. |
| `adminUrl` | string (required) | — | Fully-qualified URL of the admin app (typically `https://<adminDomain>`). |

### Slug policy

Tenant slugs become DNS subdomains; the policy below is enforced by `validateTenantSlug` in `packages/shared/src/slug.ts`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `additionalReservedSlugs` | string[] | `[]` | Per-instance reserved slugs, *added to* the base list in `packages/shared/src/slug.ts`. |
| `minSlugLength` | integer | `3` | Minimum slug length. |
| `maxSlugLength` | integer | `40` | Maximum slug length. |

### Rate limits

Defaults applied to new tenants. Individual tenant rows may override.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultDailyMessageLimitPerTenant` | integer | `1000` | Maximum outbound messages per tenant per UTC day. |
| `defaultMaxRecipientsPerGroup` | integer | `500` | Maximum active members per group. |

### Operator metadata

Rendered in footers, abuse reports, and as the DMARC contact.

| Field | Type | Description |
|-------|------|-------------|
| `operator.legalName` | string (required) | Legal name of the operator (CAN-SPAM compliance). |
| `operator.mailingAddress` | string (required) | Postal address rendered in email footers (CAN-SPAM compliance). |
| `operator.contactUrl` | string (required) | URL to the operator's contact / support page. |

### Feature toggles

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `features.byoDomainEnabled` | boolean | `false` | Whether self-service "bring-your-own-domain" signup is offered. |
| `features.publicArchivesAllowed` | boolean | `true` | Master switch for public archives. Per-group `archive_visibility` setting still applies. |
| `features.signupSelfService` | boolean | `false` | Whether public signup is enabled. `false` in V1 (operator creates tenants via CLI). |

## Sources of values, by environment

| Layer | Source |
|-------|--------|
| Generic defaults | `packages/shared/src/config.ts` exports `defaults: Partial<InstanceConfig>`. |
| Reference deployment | `deployments/bulletinmail.org/instance.config.json`. |
| Operator deployment | `deployments/<their-apex>/instance.config.json`. |
| Local dev | `instance.config.local.json` at repo root (gitignored). |
| Runtime injection | `scripts/render-wrangler.ts` merges layers, emits `[vars]` per Worker. |

## Wrangler `[vars]` mapping

Each field renders to a single `[vars]` entry in `wrangler.generated.toml`. Naming convention is `INSTANCE_<UPPER_SNAKE>`:

| Config field | Wrangler var |
|--------------|--------------|
| `apexDomain` | `INSTANCE_APEX_DOMAIN` |
| `adminDomain` | `INSTANCE_ADMIN_DOMAIN` |
| `productName` | `INSTANCE_PRODUCT_NAME` |
| `productNameShort` | `INSTANCE_PRODUCT_NAME_SHORT` |
| `tagline` | `INSTANCE_TAGLINE` |
| `supportAddress` | `INSTANCE_SUPPORT_ADDRESS` |
| `abuseAddress` | `INSTANCE_ABUSE_ADDRESS` |
| `dmarcAddress` | `INSTANCE_DMARC_ADDRESS` |
| `noreplyAddress` | `INSTANCE_NOREPLY_ADDRESS` |
| `unsubscribeAddressPrefix` | `INSTANCE_UNSUB_PREFIX` |
| `archiveUrlTemplate` | `INSTANCE_ARCHIVE_URL` |
| `unsubscribeUrlTemplate` | `INSTANCE_UNSUB_URL` |
| `adminUrl` | `INSTANCE_ADMIN_URL` |
| `additionalReservedSlugs` | `INSTANCE_RESERVED_SLUGS` (CSV) |
| `minSlugLength` | `INSTANCE_MIN_SLUG_LENGTH` |
| `maxSlugLength` | `INSTANCE_MAX_SLUG_LENGTH` |
| `defaultDailyMessageLimitPerTenant` | `INSTANCE_DEFAULT_DAILY_MSG_LIMIT` |
| `defaultMaxRecipientsPerGroup` | `INSTANCE_DEFAULT_MAX_RECIPIENTS` |
| `operator.legalName` | `INSTANCE_OPERATOR_LEGAL_NAME` |
| `operator.mailingAddress` | `INSTANCE_OPERATOR_MAILING_ADDRESS` |
| `operator.contactUrl` | `INSTANCE_OPERATOR_CONTACT_URL` |
| `features.byoDomainEnabled` | `INSTANCE_FEATURE_BYO_DOMAIN` (`"true"`/`"false"`) |
| `features.publicArchivesAllowed` | `INSTANCE_FEATURE_PUBLIC_ARCHIVES` |
| `features.signupSelfService` | `INSTANCE_FEATURE_SIGNUP_SELF_SERVICE` |

## Example

The reference deployment overlay (`deployments/bulletinmail.org/instance.config.json`):

```json
{
  "apexDomain": "bulletinmail.org",
  "adminDomain": "app.bulletinmail.org",
  "productName": "BulletinMail",
  "productNameShort": "Bulletin",
  "tagline": "Mailing lists that just work.",

  "archiveUrlTemplate": "https://bulletinmail.org/g/{tenant}/{group}",
  "unsubscribeUrlTemplate": "https://bulletinmail.org/u/{token}",
  "adminUrl": "https://app.bulletinmail.org",

  "operator": {
    "legalName": "Scott Pierce",
    "mailingAddress": "...",
    "contactUrl": "https://bulletinmail.org/contact"
  },

  "features": {
    "byoDomainEnabled": false,
    "publicArchivesAllowed": true,
    "signupSelfService": false
  }
}
```
