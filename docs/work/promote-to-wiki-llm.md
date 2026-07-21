# Promote-to-wiki + LLM extras (behind feature flags)

Part 5 of 5 of the **community-hub roadmap** (see `archive-browser.md` for the vision). The AI layer, all off-by-default: promote a mail thread into a wiki page, and re-enable cf-wiki's LLM features (auto-generated pages from red links, hero images) — each behind its own feature flag so a curious congregation can't accidentally generate cost.

## Problem

Good institutional knowledge is born in threads ("how do we run the potluck") and dies in the archive. Promote-to-wiki turns a thread into a durable doc with one click. cf-wiki's generation features (deliberately excluded in part 3) are genuinely useful but are the only part of the stack that can meaningfully consume paid resources — so they ship dark.

## Acceptance Criteria

- Instance/tenant config gains independent feature flags (suggest under `features.ai.*`):
  - `promoteToWiki` — LLM-summarized thread → wiki page draft.
  - `wikiAutogen` — cf-wiki's red-link page generation.
  - `wikiHeroImages` — image generation for pages.
  - All default **off**. Absent Workers AI binding → features hide entirely (no broken buttons).
- **Promote to wiki**: on a thread view, a member with wiki-edit permission can promote the thread; Workers AI summarizes it into a draft wiki page (title prefilled from subject, body cites/links the source thread permalink). Draft is shown for human review/edit before saving — never auto-published.
- **Wiki autogen** (when enabled): signed-in member following a red link triggers generation in the tenant wiki's voice, seeding `[[links]]`, per cf-wiki's original behavior — adapted to shared identity and tenant scoping.
- **Hero images** (when enabled): generated to R2, per cf-wiki's original behavior.
- Per-tenant usage guardrails: simple daily cap on generation calls (count in D1), with a clear "limit reached" message. Cap configurable in instance config.
- Model IDs configurable in instance config, not hard-coded, so operators can track Workers AI model deprecations.
- Generated pages indexed by unified search (part 4) like any other page.
- Audit: generation events recorded in `audit_log` (who, what, model).
- Docs: how-to page for enabling AI features, including honest cost notes for operators.

## Relevant Files

- `../cf-wiki/src/` — original generation logic (page writing, link seeding, image gen).
- `workers/community/` — thread view (promote button), wiki (red-link hook).
- `packages/shared/` — config schema for `features.ai.*` flags and caps.
- `packages/db/migrations/` — usage-counter table if needed; `audit_log` exists.
- `docs/work/wiki-transplant.md` — decisions made during the transplant that constrain this.

## Constraints

- Depends on: wiki-transplant (part 3) and unified-search-digest (part 4); archive-browser (part 1) for thread permalinks.
- Everything off by default; zero Workers AI calls when flags are off.
- Human review before any AI-generated content is published under the promote flow.
- Instance-leakage check passes; single- and multi-tenant modes.
- No emojis in UI; Lucide icons only.
