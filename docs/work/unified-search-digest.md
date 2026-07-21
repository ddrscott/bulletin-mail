# Unified search + weekly digest

Part 4 of 5 of the **community-hub roadmap** (see `archive-browser.md` for the vision). One search box over everything the org knows (mail archive threads + wiki pages) via Vectorize, and a weekly digest email summarizing recent activity — the retention feature that keeps low-engagement members connected without requiring them to visit the site.

## Problem

Content now lives in two places (archive, wiki) with no way to find anything, and members who miss a week of email have no recap. Discourse solves this with search + digest emails; both are cheap to build on Cloudflare primitives already in the stack.

## Acceptance Criteria

### Search
- Vectorize index (embeddings via Workers AI `@cf/baai/bge-base-en-v1.5` or current equivalent) covering, per tenant:
  - Mail messages (subject + body text) — indexed at ingest time in `workers/inbound`.
  - Wiki pages — indexed on save.
- Vectors metadata-scoped by `tenant_id` (and group visibility) so results never leak across tenants or into groups the member can't see.
- Search UI in the community worker: query box → mixed results (threads + wiki pages) with type badge, snippet, link.
- Backfill command (CLI or script) to index pre-existing messages/pages.
- Embedding calls stay within Workers AI free allocation at small-org scale; failures degrade gracefully (content still delivered/saved, indexing retried or skipped — never block the mail path on Vectorize).

### Digest
- Weekly cron (per-tenant schedule, default e.g. Sunday evening tenant-local or a fixed UTC time — keep simple) building a digest: new threads, active threads (message counts, participants), new/updated wiki pages, with permalinks into the archive/wiki.
- Sent through the existing sender pipeline; honors unsubscribe (digest-specific opt-out flag on `members`, distinct from list unsubscribe).
- Members with no activity that week → no email (don't send empty digests).
- Extend the existing `workers/sender/src/digest.ts` if its intent matches; otherwise replace it deliberately and note why.
- Plain HTML email, consistent with existing outbound mail styling; renders acceptably in Gmail/Apple Mail/Outlook.

## Relevant Files

- `workers/sender/src/digest.ts` — existing stub/implementation; read first.
- `workers/inbound/src/index.ts` — hook for message indexing.
- `workers/community/` — search UI + wiki save hook.
- `packages/db/migrations/` — digest opt-out flag, any index-state bookkeeping.
- `wrangler` config / `scripts/render-wrangler` — Vectorize binding + cron trigger, added to instance overlay templating.

## Constraints

- Depends on: archive-browser (part 1) and wiki-transplant (part 3). Web-reply (part 2) not required.
- LLM summarization of threads is OUT of scope (that's part 5) — the digest is structured data (titles, counts, links), not prose.
- Vectorize/Workers AI must be optional per instance config: if the binding is absent, search UI hides and digest still works (digest has no AI dependency).
- Instance-leakage check passes; single- and multi-tenant modes.
- No emojis in UI or email; Lucide icons in UI only.
