---
title: Documentation
description: BulletinMail documentation — tutorials, how-to guides, reference, and explanation.
---

Welcome to the BulletinMail docs. They're organized by the [Diataxis](https://diataxis.fr/) framework. Use the sidebar to navigate, or the search box (⌘K) for a specific term.

If you want to run BulletinMail under your own brand, the [Self-hosting guide](/docs/how-to/self-host/) is the place to begin.

## Tutorials

Learn by doing.

_No tutorials yet — start with the [Self-hosting how-to](/docs/how-to/self-host/) instead._

## How-to guides

Recipes for specific tasks.

- **[Self-host your own instance](/docs/how-to/self-host/)** — Deploy BulletinMail to your own Cloudflare account in ~90 minutes.
- **[Install BulletinMail with an LLM](/docs/how-to/install-with-llm/)** — Hand this guide to ChatGPT, Claude, or another shell-capable LLM agent. Given a Cloudflare account and a domain, the agent can bring up a single-tenant BulletinMail deployment end-to-end.
- **[Day-2 operations](/docs/how-to/operations/)** — Routine ops, incident triage, capacity, decommissioning a tenant.
- **[Browse the list archive](/docs/how-to/archive/)** — Read past list traffic on the web — threads, messages, attachments — and post replies from the browser.
- **[Enable AI features](/docs/how-to/ai-features/)** — Turn on promote-to-wiki, red-link page generation, and wiki hero images — each behind its own feature flag, off by default.

## Reference

Exhaustive material.

- **[InstanceConfig schema](/docs/reference/instance-config/)** — Per-deployment configuration: every field, type, and default.
- **[CLI reference](/docs/reference/cli/)** — `bulletin` operator commands for tenants, groups, and members.

## Explanation

The why behind the design.

- **[Architecture overview](/docs/explanation/architecture/)** — The pipeline in one paragraph + hot paths for new contributors.
- **[HTTP routing](/docs/explanation/http-routing/)** — One Worker handles every request to the apex + every subdomain (the relaytty.com playbook).
- **[Domain strategy](/docs/explanation/domain-strategy/)** — Why each tenant gets its own DNS subdomain — and the Cloudflare workaround forced on the From header.
- **[Distribution model](/docs/explanation/distribution-model/)** — AGPL-3.0 choice, three-layer separation, what lives where.
