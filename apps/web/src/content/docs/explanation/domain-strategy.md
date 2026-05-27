---
title: "Domain strategy"
description: "Why each tenant gets its own DNS subdomain — and the Cloudflare workaround forced on the From header."
---

Every BulletinMail tenant gets a real DNS subdomain of the apex. `firstpresby.bulletinmail.org`. `stmarks.bulletinmail.org`. List addresses live there: `announcements@firstpresby.bulletinmail.org`. This page is about why.

## The decision

The two hardest parts of running a public-internet mailing list are:

1. **DMARC alignment** — getting receiving mail servers to accept your outbound while you're rewriting the From header, which strict DMARC policies are designed to detect and block.
2. **IP reputation** — keeping spam complaints from one user from poisoning deliverability for everyone else on a shared sending infrastructure.

Owning the apex domain and serving every tenant from a subdomain of it makes both problems disappear. Every outbound message has a From-domain we control (apex or a verified BYO domain), which we DKIM-sign for, and which SPF authorizes via Cloudflare's outbound IP range. DMARC aligns mechanically. The reputation question is bounded by Cloudflare's infrastructure rather than ours, and per-tenant abuse signals route to a domain we can throttle.

The alternative — letting each customer point their own MX at us and somehow speaking on their behalf — is the Mailman / Sympa shape of the problem. It works but every tenant becomes a deliverability project. We don't want that.

## What "subdomain-per-tenant" looks like in practice

```
List address that members type:    announcements@firstpresby.bulletinmail.org
Inbound MX:                        *.bulletinmail.org → Cloudflare Email Routing
Outbound From we emit:             "Pastor John via FirstPresby Announcements"
                                   <firstpresby-announcements@bulletinmail.org>
Outbound Reply-To:                 announcements@firstpresby.bulletinmail.org
```

Note the asymmetry on the third line — see below.

## The address-format escape hatch

The clean version of this design has outbound `From` on the same subdomain as the list address: `From: announcements@firstpresby.bulletinmail.org`. We learned during the Phase-1 live deployment (PRD §17 #6) that Cloudflare's Email Service only authorizes outbound sends from domains with Email Routing explicitly enabled — and enabling routing on the apex doesn't cascade to subdomains. Attempting to send from a subdomain returns:

```
Error: email sending not authorized for subdomain 'firstpresby.bulletinmail.org'
```

Two ways out: enable Email Routing on each tenant subdomain at signup time (operationally expensive, and the API surface for that wasn't obvious), or move the tenant identifier to the From local-part. We took the second:

```
From: firstpresby-announcements@bulletinmail.org   (apex — authorized)
Reply-To: announcements@firstpresby.bulletinmail.org   (subdomain — Email Routing catches)
```

Members see a slightly ugly From local-part (`<slug>-<group>`) but a clean Reply-To with the natural list-address shape. DMARC alignment is preserved because the From-domain is the apex, which we DKIM-sign for. Reply flow is unaffected because Email Routing's wildcard catch-all picks up everything on `*.<apex>`.

The PRD's original §6 "Rejected alternative: slug-prefix" was framing this exact trade-off — and we ended up adopting the rejected alternative *only* for the From local-part, while keeping subdomain-per-tenant for everything else. It's a pragmatic split: the abstraction we wanted is intact for inbound, the abstraction we couldn't have is paved over for outbound, and the difference shows up nowhere in the data model.

## Reserved subdomains

Tenant slugs are real DNS subdomains, so signup must reject anything that would collide with system or future-use subdomains: `www`, `api`, `app`, `mail`, `support`, `abuse`, `dmarc`, and a few dozen others. The base list lives in `packages/shared/src/slug.ts` and applies to every BulletinMail deployment. Per-instance additions go in `InstanceConfig.additionalReservedSlugs` for operators who want to reserve their own org's marketing subdomains, etc.

The validator (`validateTenantSlug` in the same file) also enforces format: 3–40 lowercase ASCII letters/digits/hyphens, no leading or trailing hyphen, must start with a letter.

## Related

- PRD §6 — Domain Strategy (canonical)
- PRD §9.1 — DMARC Alignment via From Rewrite
- PRD §17 #6 — Outbound sender-domain authorization (the live-deployment discovery)
- [http-routing](/explanation/http-routing/) — how HTTP traffic for tenant subdomains gets handled
