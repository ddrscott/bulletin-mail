# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial PRD (`PRD.md`) describing multi-tenant architecture, email pipeline, and standards compliance.
- Open-source distribution model and `InstanceConfig` manifest (PRD §19, §20).
- Repository scaffold: workspace root, packages (`shared`, `db`, `mime`), worker stubs, CLI stub.
- Reference deployment overlay at `deployments/bulletinmail.org/`.
- Self-hosting guide (`docs/self-hosting.md`).
- Single-Worker HTTP routing (PRD §6.5): `workers/web/` handles apex + admin + every tenant subdomain via one wildcard route, host-dispatched in code (relaytty.com pattern). Includes `classifyHost` helper in `@bulletinmail/shared` and route stubs for unsubscribe, bounce-events, archive, admin, and per-tenant catch-all.

### Changed
- `workers/unsub/` and `workers/bounce/` consolidated into `workers/web/`. Their behaviors are now routes (`/u/:token`, `/api/bounce-events`) inside the single HTTP worker.
- `scripts/render-wrangler.ts` now reads `deployments/<instance>/cloudflare-resources.json` and substitutes D1 `database_id` placeholders into `wrangler.generated.toml`, so re-renders preserve operator-specific resource handles.

### Deployed
- **2026-05-25** — first production deploy of `bulletinmail-web` to `bulletinmail.org`. D1 database `bulletinmail` provisioned. Wildcard Worker route `*bulletinmail.org/*` confirmed firing on apex + admin subdomain + arbitrary tenant subdomains; host-based dispatch (`apex` / `admin` / `tenant` / `unknown`) verified end-to-end. Phase-0 HTTP routing question — does one wildcard route declaration cover everything? — answered: **yes**.
- **2026-05-25** — Phase-1 first vertical: real D1-backed unsubscribe at `/u/:token`. Schema applied to production D1 (11 tables). `resolveUnsubToken` + `unsubscribeByToken` implemented in `@bulletinmail/db`. `workers/web/src/routes/unsub.ts` now renders a real confirmation page (showing member email + group display name), processes one-click POST per RFC 8058, returns 200 on idempotent re-clicks, 404 on unknown tokens. Verified in production against a seeded test fixture (`m_alice` / `g_announcements` / `t_demo`).
- **2026-05-25** — Phase-1 implementation complete; full pipeline deployed:
  - `packages/mime`: real `subject.ts` (11 tests; covers all PRD §9.3 rows + edge cases), `parse.ts` (postal-mime wrapper, dangerous-extension stripping), `threading.ts` (parent resolution + References chain capped at 20), `build.ts` (modern Email Service `send({to, from, subject, html, text, headers, replyTo})` API, From-header rewrite for DMARC alignment, full List-* header set per RFC 2369 + 8058), `assertions.ts` (six runtime invariants from PRD §12 enforced before every send).
  - `packages/db`: full helper surface — `getTenantBySlug`/`ById`/`ByByoDomain`, `getGroupByLocalpart`/`ById`, `getMemberByEmail`/`ById`, `listActiveMembers`, `insertMessage`/`Attachment`/`Delivery`, `updateMessageStatus`, `updateDeliverySent`/`Failed`, `getOrCreateUnsubToken`, `getDeliveryByProviderMessageId`, `getAdminByEmail`, `appendAudit`.
  - `workers/inbound`: full pipeline — mailto-unsub special case → recipient resolution (subdomain or BYO) → oversize/size-limit checks → MIME parse → posting-policy validation (`members`/`open`/`announce_only`/`moderated`) → threading parent resolve → message + attachment storage → fan-out per active member. Wired as Email Routing target (catch-all rule still pending operator step).
  - `workers/sender`: full queue consumer — load message+member+group+tenant → mint unsub token → build References chain → `buildOutbound` → `assertOutboundValid` against signing-domain allowlist → `env.EMAIL.send` → record delivery. `PermanentSendError` vs transient: permanent errors ack to avoid infinite redrive; transient errors call `msg.retry()`.
  - `cli/`: real `create-tenant`, `create-group`, `add-member`, `remove-member`, `list-groups` shelling out to `wrangler d1 execute --remote` with safely escaped SQL.
  - PRD §17 updated: items #2 (bounce mechanism), #3 (sending limits), #4 (inbound size cap) resolved via Cloudflare docs; #5 deferred to V4; new #6 (outbound sender-domain authorization) and #7 (SPF-conflict blocks Email Routing enable) noted as in-flight blockers.

### Blocked on operator action (was)
- Email Routing enable refused initial attempt: two pre-existing SPF TXT records on the apex conflicted. **Resolved**: operator removed both records via the dashboard; Email Routing now `enabled: true, status: ready`.

### Email infrastructure live (2026-05-25)
- **Email Routing**: enabled on `bulletinmail.org` zone. Catch-all rule wired to `bulletinmail-inbound` Worker (`PUT /zones/.../email/routing/rules/catch_all` with `actions: [{type: "worker", value: ["bulletinmail-inbound"]}]`). Apex MX records (`route1/2/3.mx.cloudflare.net`) and DKIM key (`cf2024-1._domainkey.bulletinmail.org`) automatically provisioned.
- **Email Sending**: working from the apex. `env.EMAIL.send` from `bulletinmail-sender` succeeds — verified end-to-end with a queue-pushed `SendJob`. Cloudflare assigns Message-IDs of the form `<...@bulletinmail.org>` (captured into `deliveries.provider_message_id`).
- **Outbound From pattern adapted**: `<tenant_slug>-<group>@<apex>` (slug-prefix on local-part) instead of `<group>@<slug>.<apex>` because Email Service only authorizes the apex for sending — see PRD §17 #6 and §9.1. Reply-To still uses the subdomain pattern so inbound replies flow back via the catch-all.
- **Header whitelist conformance**: `Message-ID`, `List-Id`, `List-Post`, `List-Archive`, `Precedence`, `Auto-Submitted` are all platform-controlled or non-whitelisted by Cloudflare Email Service. Stripped from the outbound headers map; non-essential ones re-emitted under `X-Bulletin-*` for archive/debug. `assertions.ts` updated to drop the Message-ID assertion.

### Verified in production
- **Outbound (Worker → Email Service)**: queue-pushed `SendJob{messageId:"msgtest001", memberId:"m_scott"}` processed by `bulletinmail-sender`, delivered to `scott@trifectadb.com` with `provider_message_id=<TTvJTz8...@bulletinmail.org>`, delivery row updated to `status='sent'`.
- **Outbound to external (non-CF) address**: second job to `mailtester+bulletinmail@srv1.mail-tester.com` also `status='sent'`.
- **Inbound (Email Routing → Worker)**: synthetic email from `noreply@bulletinmail.org` to `test@bulletinmail.org` triggered `bulletinmail-inbound` (event captured in `wrangler tail`: `rcptTo: test@bulletinmail.org, rawSize: 4798, outcome: ok`). Worker correctly returned 5.1.1 for the unresolvable apex-only recipient.
- **CLI**: `add-member --tenant demo --group announcements --email mailtester+bulletinmail@srv1.mail-tester.com` inserted via `wrangler d1 execute --remote` with parameterized SQL — `m_01KSEZPV5NB58D5WXG1W16RVBP` created.
- **PRD §11 Phase-1 acceptance #2 (real Gmail → list → fan-out)**: live verified after wildcard MX was added. Sent from `ddrscott@gmail.com` → `announcements@demo.bulletinmail.org` → inbound parsed, validated open posting policy, inserted message `01KSFV7BPFCXM26WPVEZ2J2DE5`, fanned out to 2 active members. `bulletinmail-sender` processed both jobs to `status='sent'`. Recipient Gmail (via trifectadb forwarder) confirmed the relayed copy with `Message-ID: <I9kMJWnmBin0iakMlfYDT36fFHvfEzNpg81K@bulletinmail.org>` matching `deliveries.provider_message_id`. ARC chain `i=1` shows SPF+DKIM+DMARC all PASS on the direct delivery; the subsequent `dkim=fail` observed in Gmail is the forwarder breaking the body signature, not a setup issue.
- **PRD §11 Phase-1 acceptance #3 (reply through the list)**: live verified. `ddrscott@gmail.com` replied to the relayed copy; reply landed at `bulletinmail-inbound`, was inserted as message `01KSFVZSF26EXSGPMM94BF964R`, fanned out to 3 members (including the newly-added `ddrscott@gmail.com`). Gmail correctly threaded all relayed copies under the original subject.

### Fixed mid-session
- **Threading parent resolution now also consults `deliveries.provider_message_id`** (`packages/mime/src/threading.ts`). Cloudflare Email Service is the canonical authority on outbound Message-ID, so replies in the wild carry an `In-Reply-To` referencing the per-recipient `provider_message_id` we recorded — not anything we control. Without this lookup the inbound Worker inserted replies as orphan thread roots (visible in the first reply at `01KSFVZSF26EXSGPMM94BF964R`, which has `in_reply_to_outbound = null`). Inbound v `f9e83cbf` carries the fix; any reply landing after that point should populate `in_reply_to_outbound` correctly.

### Remaining for Phase-1 acceptance (operator-dependent)
- Wildcard MX (`*.bulletinmail.org → route1/2/3.mx.cloudflare.net`) — required to deliver `<group>@<tenant>.bulletinmail.org` inbound mail. My OAuth token lacks `dns_records:write`. Add manually via dashboard.
- Cross-client manual verification of threading (Gmail web, Apple Mail, Outlook desktop, Outlook web, Thunderbird) — PRD §11 Phase 1 #4.
- mail-tester.com 10/10 — operator fetches a real disposable address from the site and sends from any tenant address; we send + check the score.
- 7-day DMARC observation — wall-clock dependent; check `dmarc@bulletinmail.org` after 7 days for the first aggregate reports.

[Unreleased]: https://github.com/OWNER/bulletinmail/compare/HEAD
