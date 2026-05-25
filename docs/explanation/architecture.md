# Architecture overview

A short orientation for new contributors. The [PRD](../../PRD.md) is the canonical, exhaustive design document; this page exists to get you to the right neighborhood in five minutes before you dive in.

## The pipeline in one paragraph

Mail arrives at Cloudflare Email Routing (catch-all on `*@*.<apex>` and `<apex>` itself) and fires the **inbound Worker** (`workers/inbound/`). It parses MIME, resolves recipient → `(tenant, group)` via D1, validates the sender against the group's posting policy, stores the message + attachments (D1 + R2), and enqueues one job per active member into a Queue. The **sender Worker** (`workers/sender/`) consumes the queue, builds outbound MIME via `packages/mime/`, calls `env.EMAIL.send`, and records the delivery. All HTTP — unsubscribe pages, bounce-event webhook, archive viewer, admin app, marketing landing — is served by a single **web Worker** (`workers/web/`) on one wildcard route covering the apex and every subdomain.

That sentence is the whole product. Everything below is how each piece holds together.

## Three deep design choices

These three decisions account for why the codebase looks the way it does. Each has a dedicated explanation page:

- **Subdomain-per-tenant** — every tenant gets `<slug>.<apex>` so DMARC alignment and IP reputation are automatic. See [domain-strategy.md](domain-strategy.md).
- **One Worker per layer of concern, not per HTTP route** — a single Worker handles every HTTP request to the apex and every subdomain via Hono dispatch, modeled on relaytty.com. See [http-routing.md](http-routing.md).
- **Open source as a deployable application, not a library** — three-layer separation between generic code, per-instance overlay, and (eventually) hosted-only assets, under AGPL-3.0. See [distribution-model.md](distribution-model.md).

## Hot paths a contributor reads first

In rough order of importance to understanding the system:

1. `workers/inbound/src/index.ts` — recipient → tenant resolution, MIME parse, fan-out. The "front door."
2. `packages/mime/src/build.ts` — outbound MIME assembly. The From-header rewrite is non-negotiable (PRD §9.1).
3. `packages/mime/src/threading.ts` — In-Reply-To / References resolution. The hardest correctness work in the codebase (PRD §9.2).
4. `packages/shared/src/config.ts` — `InstanceConfig`. The boundary between generic code and per-deployment configuration.
5. `workers/web/src/index.ts` + `packages/shared/src/host.ts` — single-Worker HTTP dispatch over apex + tenant subdomains.

## What lives where, by question

| Question                                       | Lives in                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| Change the product name                        | `instance.config.json` (no code change)                 |
| Add a new reserved subdomain                   | `instance.config.json`                                  |
| Change the threading algorithm                 | `packages/mime/src/threading.ts`                        |
| Add a new posting policy                       | DB schema + `workers/inbound` validation switch         |
| Change the outbound From-header format         | `packages/mime/src/build.ts`                            |
| Plug in a non-Cloudflare email provider        | `workers/sender/` (the only `env.EMAIL.send` call site) |
| Add a new HTTP route at the apex               | `workers/web/src/routes/`                               |
| Add a new system address (`abuse@`, etc.)      | `InstanceConfig` + `packages/shared/src/config.ts`      |
