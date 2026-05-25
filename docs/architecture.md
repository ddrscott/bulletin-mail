# Architecture overview

A short orientation for new contributors. For the full design rationale, read [`../PRD.md`](../PRD.md) — this file is a fast skim.

## The pipeline in one paragraph

Mail arrives at Cloudflare Email Routing (catch-all on `*@*.<apex>` and `<apex>` itself) and fires the **inbound Worker** (`workers/inbound/`). It parses MIME, resolves recipient → `(tenant, group)` via D1, validates the sender against the group's posting policy, stores the message + attachments (D1 + R2), and enqueues one job per active member into a Queue. The **sender Worker** (`workers/sender/`) consumes the queue, builds outbound MIME via `packages/mime/`, sends via `env.EMAIL.send`, and records delivery. All HTTP — unsubscribe pages, bounce-event webhook, archive viewer, admin app, marketing landing — is served by a single **web Worker** (`workers/web/`) on one wildcard route covering the apex and every subdomain.

## HTTP routing: one Worker, wildcard route

Modeled on relaytty.com. The web Worker declares `routes = [{ pattern = "*<apex>/*", zone_name = "<apex>" }]` — a single rule that matches the apex and every subdomain. Inside the handler, `classifyHost(host, config)` from `@bulletinmail/shared` returns `{ kind: "apex" | "admin" | "tenant" | "unknown" }` and the request dispatches accordingly.

The trap to avoid (and the lesson the relaytty CLAUDE.md spells out): any apex-only route defined *before* the tenant catch-all will silently intercept subdomain traffic. Always guard apex-only handlers:

```ts
if (classifyHost(host, config).kind !== "apex") return next();
```

See `workers/web/src/routes/archive.ts` for the pattern in practice.

## Why subdomain-per-tenant

DMARC alignment + reputation isolation, with zero DNS configuration for tenants. See PRD §6 and §9.1.

## What's instance-agnostic vs. per-instance

- **Generic** (instance-agnostic): everything in `workers/`, `packages/`, `cli/`, `apps/`. Must read every per-instance value from a loaded `InstanceConfig` (PRD §20).
- **Per-instance:** `deployments/<apex>/instance.config.json` only. Holds apex domain, product name, support addresses, archive URL template, reserved-slug extras, operator metadata.

A CI script (`scripts/check-no-instance-leakage.sh`) hard-fails any commit that puts an instance-specific literal into generic code.

## Hot paths to understand first

1. `workers/inbound/src/index.ts` — recipient → tenant resolution + MIME parse + fan-out.
2. `packages/mime/src/build.ts` — outbound MIME assembly. The From-header rewrite is non-negotiable (PRD §9.1).
3. `packages/mime/src/threading.ts` — In-Reply-To / References resolution. Hardest correctness work in the codebase (PRD §9.2).
4. `packages/shared/src/config.ts` — the OSS abstraction point. Adding a configurable value starts here.
5. `workers/web/src/index.ts` + `packages/shared/src/host.ts` — single-Worker HTTP dispatch over apex + tenant subdomains.

## What lives where, by question

| Question                                       | Lives in                                        |
| ---------------------------------------------- | ----------------------------------------------- |
| "Change the product name to X"                 | `instance.config.json` (no code change)         |
| "Add a new reserved subdomain"                 | `instance.config.json`                          |
| "Change the threading algorithm"               | `packages/mime/src/threading.ts`                |
| "Add a new posting policy"                     | Schema + inbound worker handler                 |
| "Change the outbound From-header format"       | `packages/mime/src/build.ts`                    |
| "Plug in a non-Cloudflare email provider"      | `workers/sender/` (the only `env.EMAIL.send`)   |
