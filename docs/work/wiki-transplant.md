# Wiki transplant — fold cf-wiki into the monorepo per-tenant

Part 3 of 5 of the **community-hub roadmap** (see `archive-browser.md` for the vision). Bring the wiki from `../cf-wiki` (sibling repo, MIT-licensed, owned by same author) into this monorepo as a per-tenant knowledge base: bylaws, meeting minutes, member handbook, how-tos. Tenants get durable, linkable documents alongside their lists and archive.

## Problem

cf-wiki is a standalone single-tenant Worker (Hono, server-rendered HTML/HTMX, D1, Vectorize, Workers AI, R2, its own magic-link auth). Small orgs need its wiki alongside their mailing lists without deploying and administering a second stack with a second sign-in.

## Acceptance Criteria

- Wiki mounted per tenant (e.g. `tenant.<apex>/wiki/...`), served from the monorepo (either inside `workers/community/` or a sibling worker — decide based on bundle size and route ownership; document the decision).
- **Shared identity**: wiki uses BulletinMail's member/session/magic-link auth (`members`, `magic_links`, 6-digit code flow). cf-wiki's own auth tables/flows are NOT transplanted. One sign-in per tenant covers archive + wiki.
- Extract the shared auth/session logic into a reusable package (suggest `packages/identity`) consumed by the community/archive worker and the wiki — do not copy-paste session code between workers.
- Core wiki features carried over: page CRUD with `[[wiki link]]` syntax, revision history, R2 image storage, red links for missing pages.
- **LLM auto-generation of pages and hero images is NOT carried over in this task** — it moves behind feature flags in part 5 (`promote-to-wiki-llm.md`). The wiki must be fully useful with zero Workers AI usage.
- Multi-tenant data model: wiki tables gain `tenant_id` scoping (new migrations in `packages/db/migrations/`); page slugs unique per tenant.
- Wiki page access limited to authenticated tenant members by default; optional per-tenant "public wiki" flag is acceptable but not required.
- Vectorize indexing of pages may be stubbed/deferred to part 4 (unified search) — don't build a wiki-only search here.
- Code style converges on the monorepo idiom: Hono + server-rendered HTML, TypeScript, pnpm workspace package layout. HTMX is acceptable where cf-wiki already uses it, but don't expand it.
- License note: transplanted code is relicensed AGPL-3.0 as part of this repo (both projects same owner — deliberate decision, record it in the commit message).
- Instance-leakage check passes; works in single- and multi-tenant modes.
- Docs: how-to page for enabling/using the wiki (Diátaxis).

## Relevant Files

- `../cf-wiki/src/` — source to transplant (read its README + `docs/explanation/how-it-works.md` first).
- `packages/db/migrations/` — new wiki table migrations with tenant scoping.
- `workers/community/` — likely mount point from parts 1–2.
- New `packages/identity/` — extracted auth/session/magic-link logic.
- `packages/shared/` — config schema; add wiki feature toggle to instance config.

## Constraints

- Depends on: archive-browser (part 1) having established the Hono community worker and auth patterns. Independent of web-reply (part 2).
- No Workers AI / LLM calls in this task.
- Free-tier friendly: D1 + R2 only.
- No emojis in UI; Lucide icons only.
