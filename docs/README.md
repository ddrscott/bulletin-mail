# BulletinMail documentation

Documentation is organized by [Diataxis](https://diataxis.fr/) into four quadrants. Find what you need by what you're trying to do:

```
                    PRACTICAL                       THEORETICAL
                  (steps to follow)            (knowledge to absorb)

  STUDY      Tutorial                       Explanation
             "I want to learn this"         "I want to understand this"

  WORK       How-to guide                   Reference
             "I want to accomplish X"       "I want to look up Y"
```

## Tutorial — learning by doing

Step-by-step walkthroughs that get you to a working state. Skim or follow, but follow in order.

- (none yet — `how-to/self-host.md` is the closest)

## How-to guide — accomplish a specific task

Recipe-style. Assumes you know what you're doing; gets you to the answer fast.

- [Self-host your own instance](how-to/self-host.md) — apex zone setup, DNS records, Cloudflare resources, deploy, first tenant. **Start here** if you want to run BulletinMail somewhere other than `bulletinmail.org`.
- [Day-2 operations runbook](how-to/operations.md) — routine ops, incident triage, capacity, decommissioning a tenant.

## Reference — look up the facts

Neutral, complete, machine-readable. The truth of what the system does and how it's configured.

- [`InstanceConfig` schema](reference/instance-config.md) — every per-deployment configuration field, type, default, where it surfaces.
- [CLI commands](reference/cli.md) — `bulletin` operator CLI subcommand reference.
- [PRD §7 — D1 schema](../PRD.md#7-data-model-d1) — full table + column definitions. (Not extracted; the PRD is authoritative.)
- [PRD §9 — email-standards header set](../PRD.md#9-email-standards-compliance-non-negotiable) — the exact headers we emit and why.

## Explanation — understanding the design

Discursive treatment. Read on a coffee break. Designed to help you reason about the system, not to instruct.

- [Architecture overview](explanation/architecture.md) — the pipeline in one paragraph + hot paths for new contributors.
- [Domain strategy: subdomain-per-tenant](explanation/domain-strategy.md) — why each tenant gets its own DNS subdomain, and the workaround forced by Cloudflare's sender-domain authorization.
- [HTTP routing pattern](explanation/http-routing.md) — why one Worker handles every request to the apex + every subdomain, modeled on relaytty.com.
- [Distribution model](explanation/distribution-model.md) — AGPL-3.0 choice, three-layer separation, what lives where.

## The PRD is also documentation

[`PRD.md`](../PRD.md) is the canonical design document — twenty sections plus an appendix walking through the architectural decisions, data model, email pipeline, and standards compliance. It's longer than any of the docs here, and where this directory and the PRD disagree, **the PRD wins**. Explanation pages above are concentrated extracts of PRD chapters meant for orientation rather than depth.

## Contributing to docs

Add to whichever quadrant the content belongs in. Don't mix types:

- Explanation pages **don't include steps** — link to a how-to.
- How-to pages **don't include design rationale** — link to an explanation.
- Reference pages **don't include opinions or context** — they're just facts.
- Tutorials **don't branch or list alternatives** — there's one path and it works.

When in doubt, [diataxis.fr](https://diataxis.fr/) has examples.
