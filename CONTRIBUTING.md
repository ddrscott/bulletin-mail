# Contributing to BulletinMail

Thanks for your interest. BulletinMail is a small project run by a single maintainer; bug reports, doc fixes, and tightly-scoped PRs are the most welcome contributions.

## Before you start

1. Open an issue describing the change before writing significant code. Architecture is documented in [`PRD.md`](PRD.md) — most "wouldn't it be nice if" features are explicit non-goals (see PRD §2 and §14).
2. Tasks worth attempting are usually labeled `good first issue` or `help wanted`.

## Development

```sh
pnpm install
pnpm test                     # all packages
pnpm typecheck                # all packages
pnpm check-instance-leakage   # generic code must not mention any specific apex domain
```

## Commit style

- One logical change per commit. Squash on merge.
- Conventional-commits header (`feat:`, `fix:`, `docs:`, ...) is encouraged but not required.
- **Sign off every commit** with `git commit -s` — this asserts the [Developer Certificate of Origin](https://developercertificate.org/). PRs without DCO sign-off cannot be merged.

## License

By submitting a contribution, you agree that it will be licensed under [AGPL-3.0-only](LICENSE), the same license as the rest of the project. The project does **not** require copyright assignment.

## What this project does not want

- Marketing-email features (A/B testing, open/click tracking, merge tags). The PRD is explicit: this is two-way discussion + announcements. If your use case needs those features, use Mailchimp.
- Frontend frameworks. The admin UI is intentionally plain HTML + TS.
- Configuration systems beyond the single `instance.config.json`. No YAML profiles, no env-driven feature flags, no per-tenant override files.
- Node-only or native-module dependencies inside Workers. If something must run outside the Worker runtime, it goes in `cli/`.

## Reporting security issues

Email `security@bulletinmail.org`. Do not file public issues for vulnerabilities.
