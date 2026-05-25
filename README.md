# BulletinMail

> A mailing-list service that just works. Open source. Built on Cloudflare's developer platform.

BulletinMail lets a volunteer church administrator create a list in 60 seconds and have the next email a pastor sends reach every member with proper threading in Gmail, Apple Mail, and Outlook. No DNS to configure (for tenants). No per-seat pricing. No spam-folder hell.

## Two ways to use it

**Hosted at [bulletinmail.org](https://bulletinmail.org)** — the reference instance, run by the project maintainer. Free tier for small congregations; paid tier for bring-your-own-domain.

**Self-host your own instance** — point your own apex domain at Cloudflare, follow [`docs/self-hosting.md`](docs/self-hosting.md), and run BulletinMail under your own brand on your own Cloudflare account. The whole stack fits comfortably in Cloudflare's free / low tier for small-org use.

## Why it works

The architectural bet: **owning the parent domain** (and serving every tenant from a subdomain of it) eliminates the two hardest parts of running a listserv — DMARC alignment and IP reputation. Cloudflare's Email Routing + Email Sending stack handles the rest.

Full design in [`PRD.md`](PRD.md). Cross-phase invariants in §12. Open-source distribution model in §19. Instance configuration manifest in §20.

## Tech

| Layer            | Choice                                  |
| ---------------- | --------------------------------------- |
| Runtime          | Cloudflare Workers (TypeScript)         |
| Inbound mail     | Cloudflare Email Routing                |
| Outbound mail    | Cloudflare Email Sending                |
| Database         | Cloudflare D1                           |
| Object storage   | Cloudflare R2                           |
| Async fan-out    | Cloudflare Queues                       |
| Admin UI         | Cloudflare Pages, plain HTML + TS       |
| Auth             | Magic links only — no passwords         |
| Package manager  | pnpm workspaces                         |

No frontend framework. No Node-only dependencies in Workers.

## Repository layout

```
bulletinmail/
├── workers/                 # Cloudflare Workers (inbound, sender, unsub, bounce, admin-api)
├── packages/                # generic, instance-agnostic code
│   ├── shared/              #   config schema, slug validator, reserved subdomains
│   ├── db/                  #   D1 migrations + typed query helpers
│   └── mime/                #   parse, build, threading, subject prefix
├── apps/admin/              # admin UI (Phase 2)
├── cli/                     # operator CLI (create-tenant, add-member, ...)
├── deployments/
│   └── bulletinmail.org/    # reference-instance overlay; your fork adds a sibling
├── docs/                    # self-hosting, operations, architecture
├── scripts/                 # render-wrangler, db-migrate, CI checks
└── PRD.md                   # full product + architecture design doc
```

The separation between generic code and per-instance overlay is enforced by `scripts/check-no-instance-leakage.sh` in CI — generic code may not contain the string `bulletinmail.org` (or any other apex literal).

## Quick start (development)

```sh
git clone https://github.com/ddrscott/bulletin-mail.git
cd bulletinmail
pnpm install
cp instance.config.example.json instance.config.local.json
# edit instance.config.local.json with your dev apex domain
pnpm dev:inbound  # in one terminal
pnpm dev:sender   # in another
```

## Quick start (self-hosting in production)

See [`docs/self-hosting.md`](docs/self-hosting.md). High level:

1. Register an apex domain and add it to your Cloudflare account.
2. Add DNS records (MX wildcard + apex, SPF, DKIM, DMARC) — templates in the guide.
3. Create D1, R2, and Queue resources (`wrangler` commands provided).
4. Copy `deployments/bulletinmail.org/` to `deployments/<your-apex>/` and edit.
5. `pnpm render-wrangler --instance <your-apex>` then `pnpm -r deploy`.
6. `pnpm cli create-tenant ...` to create your first tenant + list.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Commits must be DCO-signed (`git commit -s`). All contributions licensed AGPL-3.0 by submission.

## License

[AGPL-3.0-only](LICENSE). The name **BulletinMail** and `bulletinmail.org` are trademarks of the project maintainer — forks that run BulletinMail as a service must rebrand. Self-hosting under your own brand (or no brand at all) is fine.

---

*Built for the small organizations who shouldn't need a sysadmin to send announcements.*
