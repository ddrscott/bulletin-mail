---
title: "Distribution model"
description: "AGPL-3.0 choice, three-layer separation, what lives where."
---

BulletinMail is open source, AGPL-3.0-only, and structured as a **deployable application, not a library**. This page is about why those words matter and what they mean for how the codebase is organized.

## License: AGPL-3.0-only

The whole product *is* the hosted service. There is no separable "library" that someone else can embed in their unrelated SaaS. That makes the trade-off straightforward:

- **AGPL** closes the SaaS loophole that plain GPL leaves open. If someone runs a modified BulletinMail as a service for third parties, they must publish their modifications. This protects the project's commercial viability without preventing genuine self-hosting.
- **Permissive licenses (MIT, Apache 2.0)** would invite the obvious extraction: someone takes the code, rebrands it, runs it as a service, and contributes nothing back. For a project where the maintainer wants to operate the canonical hosted instance (`bulletinmail.org`), AGPL is the right default.
- **Internal self-hosting carries no obligation** — a single church running its own copy for itself doesn't trigger the AGPL service clause. The community of "small organizations running BulletinMail privately" is the audience this picks up.

Same playbook as Plausible, Cal.com, Mattermost. None of them have suffered for the choice; if anything it's been a marketing asset (clear story for buyers about who's behind the project).

## Three-layer separation

The repository has three concentric layers. Downstream operators depend on the inner two; the outer one is irrelevant to anyone running their own instance.

```
┌─────────────────────────────────────────────────────────────┐
│ 3. Hosted-only assets (none in V1)                          │
│    Future paid features available only on bulletinmail.org. │
│    If we add them, they live in a separate private repo.    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 2. Instance overlay — deployments/<apex>/             │  │
│  │    Per-deployment config, DNS notes, brand assets,    │  │
│  │    Cloudflare resource handles. One directory per     │  │
│  │    deployment. The reference instance lives at        │  │
│  │    deployments/bulletinmail.org/. Operator forks add  │  │
│  │    their own sibling (or delete ours).                │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │ 1. Generic code — workers/, packages/,          │  │  │
│  │  │    cli/, apps/                                  │  │  │
│  │  │    Knows nothing about any specific deployment. │  │  │
│  │  │    Reads every per-instance value from a loaded │  │  │
│  │  │    InstanceConfig at runtime.                   │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

A CI check (`scripts/check-no-instance-leakage.sh`) hard-fails any commit that puts an apex literal (e.g. `bulletinmail.org`) into generic code. The rule isn't aspirational — it's enforced.

This split matters because:

- A fork that wants to run a private BulletinMail under their own brand changes **one file** (their `deployments/<their-apex>/instance.config.json`) — never code.
- Layer 1 stays clean across upstream and forks. Pulling a new release in is a fast-forward merge.
- Branding and identity are deployment-time concerns, not source-time concerns. Plausible has this exact model.

## What lives where

A few common questions and which layer answers each:

| Question                                       | Layer                                       |
| ---------------------------------------------- | ------------------------------------------- |
| Change the product name from "BulletinMail" to "ChurchLists" | Layer 2: `instance.config.json` (`productName` field)        |
| Add a new tenant subdomain reserved for our org              | Layer 2: `instance.config.json` (`additionalReservedSlugs`)  |
| Change which support address handles abuse                   | Layer 2: `instance.config.json`                              |
| Add a custom logo to the unsubscribe page                    | Layer 2: per-instance assets (or fork Layer 1 carefully)     |
| Change the threading algorithm                               | Layer 1: `packages/mime/src/threading.ts`                    |
| Add a new posting policy                                     | Layer 1: D1 schema + worker validation                       |
| Run a private fork with a different name                     | Fork the repo; replace Layer 2; license obligations apply if you run it as a service |

## Trademark, separately

The AGPL covers **code only**. The name "BulletinMail," the wordmark, and `bulletinmail.org` are trademarks of the project maintainer. Anyone running a service under a different name from a fork is welcome; running a service under the BulletinMail name from a fork is not. Same as Mattermost's "unbranded build" rule.

Self-hosting under your own brand or no brand at all is fine, and is what the architecture is designed for.

## Governance (V1)

Single maintainer, BDFL model. No corporate CLA. Contributors retain copyright; the project requires only the AGPL inbound-equals-outbound grant via Developer Certificate of Origin sign-off in commits (`git commit -s`). The CI workflow enforces DCO on every PR.

This will get more formal if contribution volume justifies it. Until then, simple wins.

## Related

- PRD §19 — Distribution Model (canonical)
- PRD §20 — Instance Configuration Manifest
- [reference/instance-config](/reference/instance-config/) — every field in the `InstanceConfig` schema
- [`CONTRIBUTING.md`](https://github.com/ddrscott/bulletin-mail/blob/main/CONTRIBUTING.md) — DCO + commit conventions
