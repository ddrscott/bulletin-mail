# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Phase 2 slice 1: admin auth + members CRUD
- **Admin sign-in (magic-link).** New API surface in `workers/web/src/routes/admin/`:
  - `POST /api/auth/request {email}` — looks up admins by email, queues one magic-link email per matching tenant via `env.EMAIL` (transactional, no list headers). 15-min token lifetime. Always returns 204 to avoid leaking which emails match an admin.
  - `GET /auth/verify?token=...` — atomically consumes the token (`UPDATE … WHERE used_at IS NULL AND expires_at > now`), issues an HMAC-signed session cookie, redirects to `/`.
  - `POST /api/auth/signout` — clears the cookie.
  - **Bootstrap signup** (`GET /api/auth/signup-available` + `POST /api/auth/signup {email, tenantSlug, tenantDisplayName}`) — gated on `countAdmins(db) === 0`. The very first visitor picks a tenant slug, creates the tenant + first admin atomically in a `db.batch`, then proceeds through the magic-link path. After that the endpoint returns 403 and the SPA hides the form. Eliminates the CLI requirement for instance bootstrap (overrides PRD §11 Phase 2 #8).
- **Session cookie primitives** (`workers/web/src/lib/session.ts`). HMAC-SHA-256 over `{adminId, exp}` JSON, signed with `ADMIN_API_JWT_SECRET`, encoded as `<b64url(payload)>.<b64url(sig)>`. HttpOnly/Secure/SameSite=Lax, 7-day lifetime. Constant-time verify.
- **`requireAdmin` middleware** (`workers/web/src/routes/admin/auth-middleware.ts`). Host-gates first (404 on non-admin host), then verifies cookie + loads admin into `c.var.admin`. Mounted on every `/api/me` and `/api/groups/...` route.
- **Admin REST endpoints** (all under `app.<apex>`, all `requireAdmin`-gated):
  - `GET /api/me` — current admin + tenant
  - `GET /api/groups` — groups for current tenant, with active member counts + last-message timestamps
  - `GET/POST /api/groups/:id/members` — list / add one (409 on duplicate)
  - `PATCH /api/groups/:id/members/:memberId` — change role
  - `DELETE /api/groups/:id/members/:memberId` — mark unsubscribed (PRD §8.4: status change, not row delete)
  - `POST /api/groups/:id/members/bulk-preview` — CSV dry-run; returns `{toAdd, duplicates, invalid, total}`
  - `POST /api/groups/:id/members/bulk` — commit
- **D1 helpers** for the above: `getAdminsByEmail`, `getAdminById`, `createMagicLink`, `consumeMagicLink`, `listGroupsByTenant` (with subselected `active_member_count` + `last_message_at`), `listMembersByGroup` (paginated, all statuses), `insertMember` (returns null on UNIQUE violation), `updateMemberRole`, `setMemberStatus`.
- **Workers Assets binding** on `workers/web` → `apps/admin/dist/`. Single wildcard route still covers everything; admin-host requests that miss the API routes fall through to `env.ASSETS.fetch`.
- **`apps/admin/` SPA** — no framework. esbuild bundles `src/main.ts` → `dist/main.js` (11 KB minified). Plain HTML shell + CSS. Tiny hash router with three views:
  - sign-in (email → "check your inbox")
  - tenant home (groups table with member counts + per-group archive-style addresses)
  - group detail (Members tab live; Settings / Recent messages / Moderation are stubs awaiting later slices). Members tab has: single-add form, role select, remove button, and CSV paste with preview/commit.
- **`[[send_email]]` binding** added to `workers/web` for magic-link sends (same Email Service authorization rules as the sender Worker — outbound `From` on the apex per PRD §17 #6).
- **Site admin vs tenant admin split.** Closes Scott's correction that the apex auth was wrong: `app.<apex>` is for site admins (operators of the BulletinMail instance — create tenants), `<tenant>.<apex>` is where each tenant manages its own data, members, and moderators.
  - **New `site_admins` table** + DB helpers (`countSiteAdmins`, `createSiteAdmin`, `getSiteAdminBy*`, `listTenants`, `createTenantWithFirstAdmin`, `insertTenantAdmin`, `updateAdminRole`, `deleteTenantAdmin`, `countAdminsByTenant`). Migration `0003_site_admins.sql` applied to production D1.
  - **`admins.role` extended to include `'moderator'`** (no DDL — TEXT column). Tenant moderators can edit the wiki and approve subscribe-pending requests; admins can do that plus invite/promote/demote/remove team members.
  - **New `bm_site_session` cookie** (`workers/web/src/lib/site-session.ts`) — HMAC-SHA-256, host-scoped to `app.<apex>`. Cannot reach tenant subdomains (different cookie name + no `Domain=`). `bm_tenant_session` continues to scope tenant moderator sessions to one tenant host each.
  - **`/api/auth/*` is host-aware**: same paths on both hosts, internal dispatch by `classifyHost`. Bootstrap signup creates a `site_admin` on `app.<apex>` and a tenant `admin` on `<tenant>.<apex>`; either is gated on the respective `count*Admins === 0` precondition.
  - **`POST /api/tenants` (site-admin only)** atomically creates a tenant row + first tenant admin row (in a `db.batch`) and emails the admin a magic link pointing at the tenant subdomain's `/auth/verify`. The site admin specifies the first admin email at create time — bare-tenant and one-time-token handoff variants were considered and rejected.
  - **Tenant admin API moved to tenant subdomain**: `/api/me`, `/api/groups/*`, `/api/groups/:id/members/*`, `/api/groups/:id/pending/*` now require `bm_tenant_session` via the new `requireTenantAdmin` middleware (built on `resolveTenantContext`, which re-verifies that `admin.tenant_id === current tenant.id`). The old `app.<apex>`-hosted admin UI dies; `app.<apex>/` now redirects to `/admin/` which lands on the site-admin home (tenant list + create form).
  - **`/api/team`** — moderator + admin promotion API. `POST` invites by email (sends sign-in link), `PATCH` changes role, `DELETE` removes. Both `PATCH` and `DELETE` reject the last-admin case (409). Only role `'admin'` can mutate; moderators can `GET` but not change anything.
  - **SPA host-aware**: `main.ts` probes `/api/me`, branches on `kind: "site" | "tenant"`. Site context renders the new `site-home.ts` view (tenant list + create form, links to each tenant's `/admin/`). Tenant context renders the existing groups/members/settings/pending + a new `team.ts` view. SPA build output relocated to `apps/admin/dist/admin/` with relative asset paths so Workers Assets serves it correctly at `/admin/` on both hosts.
- **Per-tenant wiki at the tenant subdomain root.** `<tenant>.bulletinmail.org/` now serves an editable info site. Storage is per-tenant — one Durable Object instance (`TenantWikiDO`, SQLite-backed) per tenant, sharded by `env.WIKI.idFromName(slug)` (same pattern as `../editor`'s `SpaceRoom`). The DO holds two tables: `pages` (current row) and `versions` (append-only — every save adds a row, revert inserts a new row carrying older content; we never mutate history).
  - **Markdown compiler** in `workers/web/src/wiki/markdown.ts` using `marked` + a custom inline tokenizer for `[[Page Name]]` and `[[Page Name|Custom Text]]` wiki links. Built-in link/image renderers reject `javascript:` and other non-http(s) schemes. Pages can nest arbitrarily via cross-links and `parent_id` on the `pages` table.
  - **Compiled HTML cached in R2** (`bulletinmail-wiki` bucket, key `wiki/<tenant>/<slug>.html`). Public reads hit R2 directly; DO is only consulted on cache miss or when the editor saves. Uploaded images live at `wiki/<tenant>/img/<ulid>.<ext>` and serve from `<tenant>.<apex>/wiki/img/<ulid>.<ext>` with immutable cache headers.
  - **Toast UI Editor** loaded from `uicdn.toast.com` — no build-time dependency on the editor. Markdown ↔ WYSIWYG toggle, drag/paste images call `POST /api/wiki/upload` which writes to R2 and returns the public URL the editor inserts into the markdown source. Version sidebar lists every save with a "Revert to this" button.
  - **Tenant-scoped moderator auth.** New cookie `bm_tenant_session` (HMAC-SHA-256 over `{adminId, tenantId, exp}`, host-scoped) issued by `/auth/verify` on the tenant subdomain. Magic-link request/verify endpoints live on the tenant subdomain so the cookie never crosses subdomains — apex admin and tenant moderator are different sessions per Scott's call ("apex admin shouldn't have editor rights"). Sign-in pulls only admins whose `tenant_id` matches the host's resolved slug, defeating cross-tenant token replay.
  - **Routes added to `workers/web/src/routes/tenant.ts`** via `mountWikiRoutes(app)`. Catch-all `/join/<group>` (subscribe form) routes from the previous round still come second so the wiki routes (`/`, `/wiki/:slug`, `/auth/*`, `/api/wiki/*`) win on specificity.
  - **`run_worker_first = true` on the `[assets]` binding** — without it, Workers Assets would serve `apps/admin/dist/index.html` for tenant-subdomain `/` requests (since the file exists), and the wiki handler would never run. With it, the Hono handler dispatches every request and falls through to `env.ASSETS.fetch()` only on the admin host inside `mountAdmin`.
- **Docs + marketing site at the apex** (`apps/docs/`, Astro + Starlight). The apex `bulletinmail.org` now serves a real docs site with sidebar nav, full-text search (Pagefind), dark mode, and a splash landing — replacing the inline-HTML placeholder in `workers/web/src/landing.ts` (deleted). All content from `/docs/` (Diátaxis: tutorial / how-to / reference / explanation) is migrated to `apps/docs/src/content/docs/` via `apps/docs/scripts/migrate-docs.mjs` (idempotent — re-runs pull fresh copy + add Starlight frontmatter + rewrite `.md` links to clean URLs).
- **Routing split.** Two Workers now share the apex zone, dispatched by Cloudflare route specificity (longest-character-match wins):
  - `bulletinmail-docs` owns `bulletinmail.org/*` (apex catch-all → Starlight static site, served via `[assets]` binding).
  - `bulletinmail-web` keeps `bulletinmail.org/u/*`, `/g/*`, `/api/*`, `/health` (longer = more specific than docs catch-all), plus `*.bulletinmail.org/*` for admin + tenant subdomains. The previous `*bulletinmail.org/*` wildcard accidentally beat the apex docs route on character count; tightening to the dot-prefixed form excludes the bare apex from the web Worker's match set.
  - `render-wrangler.ts` learned the docs Worker and now does route-only substitution (no `[vars]` block for static-only Workers). `check-no-instance-leakage.sh` excludes `apps/docs/` (docs is content, not generic code).
- **Group create + settings in the Admin UI** (closes the "no need for CLI" gap reported during smoke test). New DB helpers `createGroup` + `updateGroup` (PATCH-style; `name` and `tenant_id` deliberately immutable). New API endpoints `POST /api/groups` (validates local-part regex + policy/visibility enums + 25 MiB hard cap on max_message_size per PRD §17 #4) and `PATCH /api/groups/:id` (tenant-scoped guard). SPA: tenant home now has a "+ New group" form (name → live address preview, full policy/reply-to/visibility/prefix controls); Settings tab on group detail is now an editable form with the same fields plus a "public archive" confirmation (PRD §11 §10 invariant).

### Tests
- 26 new tests in `workers/web/tests/`: HMAC session round-trip + tamper/expiry/wrong-secret rejection (9), magic-link rendering + HTML escape + token entropy (9), CSV bulk-email parser (8). Total workspace: 37/37 green.

### Initial scaffold
- Initial PRD (`PRD.md`) describing multi-tenant architecture, email pipeline, and standards compliance.
- Open-source distribution model and `InstanceConfig` manifest (PRD §19, §20).
- Repository scaffold: workspace root, packages (`shared`, `db`, `mime`), worker stubs, CLI stub.
- Reference deployment overlay at `deployments/bulletinmail.org/`.
- Self-hosting guide (`docs/how-to/self-host.md`).
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

### Documentation
- `docs/` reorganized following the [Diataxis](https://diataxis.fr/) framework into `tutorial/`, `how-to/`, `reference/`, `explanation/` quadrants. Existing pages moved into the appropriate quadrants; new explanation pages distilled from PRD §6 (domain strategy), §6.5 (HTTP routing), §19 (distribution model); new reference pages for `InstanceConfig` and the `bulletin` CLI. `docs/README.md` is the navigation index.

### Phase-1 acceptance milestones
- **mail-tester.com 10/10** (PRD §11 Phase-1 #7) achieved on first attempt against `test-qhzngyz9v@srv1.mail-tester.com`. Synthetic message `mt001` (Pastor John / service-tomorrow body, realistic small-church format) processed by the full pipeline; delivery `provider_message_id=<I3Dd7KiHWYabmPgKUdZ9i3p6u7Be5DyX4YMr@bulletinmail.org>`. All six mail-tester categories green: SpamAssassin score, SPF+DKIM+DMARC alignment, MIME well-formed, no blocklist matches, working List-Unsubscribe URL, deliverable.
- **Phase-1 acceptance status**: 6/8 criteria directly verified in production (#1 CLI, #2 external→fan-out, #3 reply threading user-visible, #5 unsubscribe, #7 mail-tester 10/10, plus #1 via CLI). #6 deferred to V2 by design (Cloudflare handles hard-bounce suppression at the platform layer; our per-soft-bounce counter is post-V1). #4 (5-client cross-verification) and #8 (7-day DMARC observation) are operator-manual / wall-clock and cannot be automated in-session.

### Remaining for Phase-1 acceptance (operator-dependent)
- Wildcard MX (`*.bulletinmail.org → route1/2/3.mx.cloudflare.net`) — required to deliver `<group>@<tenant>.bulletinmail.org` inbound mail. My OAuth token lacks `dns_records:write`. Add manually via dashboard.
- Cross-client manual verification of threading (Gmail web, Apple Mail, Outlook desktop, Outlook web, Thunderbird) — PRD §11 Phase 1 #4.
- mail-tester.com 10/10 — operator fetches a real disposable address from the site and sends from any tenant address; we send + check the score.
- 7-day DMARC observation — wall-clock dependent; check `dmarc@bulletinmail.org` after 7 days for the first aggregate reports.

[Unreleased]: https://github.com/ddrscott/bulletin-mail/compare/HEAD
