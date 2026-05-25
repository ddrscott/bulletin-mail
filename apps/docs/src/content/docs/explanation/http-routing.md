---
title: "HTTP routing"
description: "One Worker handles every request to the apex + every subdomain (the relaytty.com playbook)."
---

Every HTTP request to a BulletinMail instance — the apex marketing page, the `/u/<token>` unsubscribe handler, the eventual admin app at `app.<apex>`, an archive viewer at `<tenant>.<apex>/g/<group>`, a bounce-event webhook — is served by **a single Worker**. There is no per-route, per-tenant, or per-feature HTTP deployment. This page is about why we made that choice and what the pattern looks like.

## The pattern

Borrowed wholesale from [relaytty.com](https://relaytty.com), which solves a structurally identical problem: it has a single apex domain (`relaytty.com`) with arbitrary opaque subdomains (`x7k9m2.relaytty.com`) that need to hit the same code. Their Worker config is a single line:

```toml
routes = [
  { pattern = "*<apex>/*", zone_name = "<apex>" }
]
```

The leading `*` without a dot is the magic. It matches:

- `<apex>` itself (apex landing, `/u/<token>`, `/api/bounce-events`)
- `app.<apex>` (admin app + admin-api)
- `firstpresby.<apex>`, `stmarks.<apex>`, every tenant subdomain we'll ever provision

— all with **one route declaration**, with no per-tenant DNS or routing config to mutate at signup time. Adding a new tenant requires no Cloudflare API calls beyond inserting their row in D1.

## Inside the Worker: host-based dispatch

`packages/shared/src/host.ts` exports `classifyHost(host, config)`:

```ts
type HostKind =
  | { kind: "apex" }
  | { kind: "admin" }
  | { kind: "tenant"; slug: string }
  | { kind: "unknown" };
```

Every route in `workers/web/` either declares which host kind it serves or guards explicitly with `if (classifyHost(host, config).kind !== "apex") return next();`. Tenant catch-all sits at the bottom of the Hono router.

## The trap to avoid

The relaytty `CLAUDE.md` spells out the lesson their team learned the hard way, and it applies verbatim here: **any apex-only route defined before the tenant catch-all will silently intercept subdomain traffic**. If you add `GET /assets/*` at the top of the Hono app and don't guard it for host kind, a request to `firstpresby.<apex>/assets/style.css` will hit it and return apex content. Users won't get an error — they'll get the wrong page. That's the worst kind of bug.

Fix: every apex-handled route checks `classifyHost(host, config)` at the top of its handler and calls `next()` if the host isn't apex. Examples in `workers/web/src/routes/archive.ts`.

## Why one Worker instead of one-per-concern

The natural instinct is to give each concern its own Worker: one for unsubscribe, one for the admin API, one for the archive viewer, one for the marketing site. We initially scaffolded it that way (`workers/unsub/`, `workers/bounce/`, plus a planned `workers/admin-api/`). Three deploy targets, three sets of bindings, three `wrangler.toml`s.

The relaytty pattern collapses all of that. Operationally:

- One route declaration to maintain
- One deploy command in CI
- One `wrangler tail` to watch traffic
- One Hono app means cross-cutting concerns (auth, CSP, rate limits, error pages) live in one place rather than duplicated three times
- Cold-start cost is borne once

The trade-off is **coupling**: one bad deploy can break the unsubscribe endpoint *and* the admin app. We accept that because:

- The blast radius is bounded — every concern is HTTP, all stateless, all reading the same D1 + R2 bindings
- Cloudflare's instant rollback (`wrangler rollback`) cuts the cost of a bad deploy to seconds
- The operational simplicity is worth more than the isolation, especially for a small-org service running on Workers free / low tier

Workers that **aren't** HTTP stay separate:

- `workers/inbound` is invoked by Cloudflare Email Routing's `email()` handler — totally different surface, can't be HTTP-routed
- `workers/sender` is a Queue consumer with a `queue()` handler — same story

Two non-HTTP workers + one HTTP worker is the right shape for this system.

## Related

- PRD §6.5 — HTTP routing (canonical)
- PRD §4 — Architecture diagram
- relaytty.com's `CLAUDE.md` — the lesson we lifted from
- `workers/web/src/index.ts` — the Hono app
- `workers/web/src/routes/*.ts` — host-guarded route handlers
