# Archive browser — read-only web view of list threads

Part 1 of 5 of the **community-hub roadmap**: evolve BulletinMail into an email-first community hub (email lists + forum-style archive + wiki) for small orgs, staying within Cloudflare free/low tier. The forum is the web view of the mailing-list archive — not a separate system. Discourse concepts map as: category → group/list, topic → email thread, post → message.

## Problem

List traffic is delivered but not browsable. Members who join late, delete emails, or want to find "that thread about the fall festival" have nothing. A read-only archive makes email durable and is the foundation the web-reply forum (part 2) builds on.

## Acceptance Criteria

- Signed-in members of a tenant can browse at `tenant.<apex>`:
  - Group (list) index → thread list per group (subject, participant count, message count, last-activity), newest activity first, paginated.
  - Thread view: messages in thread order (via `Message-ID`/`References` threading from `packages/mime`), sender display name, timestamp, sanitized HTML or rendered plain text.
  - Attachments listed and downloadable (auth-checked, served from R2).
- Access control: only authenticated members of that tenant can view; group-level visibility respects existing group membership (a member sees only groups they belong to, unless group is tenant-public).
- Threads have stable URLs (e.g. `/t/<thread-id>`) — these become permalinks the digest (part 4) links to.
- Uses existing magic-link auth (D1 `magic_links` / `site_magic_links` + 6-digit code flow) — no new auth system.
- Server-rendered HTML via **Hono** — this task establishes the Hono + server-rendered-HTML idiom that later roadmap parts (wiki transplant, web reply) build on. No frontend framework, no client build step beyond what exists.
- HTML email bodies sanitized before rendering (no script/style/iframe/external tracking pixels by default).
- Works in single-tenant mode (`features.singleTenant`) and multi-tenant mode.
- Instance-agnostic: no apex literals in generic code (`scripts/check-no-instance-leakage.sh` must pass).

## Relevant Files

- `packages/db/migrations/` — `messages`, `attachments`, `groups`, `members`, `tenants` tables already exist; add a thread-id/threading index migration if needed.
- `packages/mime/` — existing threading logic (Message-ID / References / subject).
- `workers/inbound/src/index.ts` — where messages are ingested; may need to persist thread linkage at ingest time.
- New worker (suggest `workers/community/`) — Hono app serving the archive UI.
- `PRD.md` — invariants in §12; check tenancy/routing model before adding routes.

## Constraints

- Read-only in this task — no posting UI (that's part 2: web-reply).
- Free-tier friendly: no Queues dependency for serving; D1 + R2 reads only.
- Follow existing repo conventions (pnpm workspaces, instance overlay in `deployments/`, Diátaxis docs — add a how-to page for the archive).
- No emojis in UI; use Lucide icons if icons are needed.
