# AI-summarize wiki edits + tenant activity feed

## Problem

Tenant moderators have no central view of what's changing across their wiki. To track edits today they'd have to open each page individually and walk the version history panel. For tenants with multiple editors (e.g. a church staff team), this scales badly.

## Outcome

After every save, generate a 1–2 sentence plain-English summary of the change using Cloudflare Workers AI. Store the summary on the version row. Render a tenant-admin "activity" feed showing recent versions across all pages with summaries.

## Acceptance criteria

- Schema: `wiki_versions` gains a `summary TEXT NULL` column. Older rows stay null; no backfill.
- Save handler (`server/wiki/do.ts` or wherever the version write lives): after the version row is committed, fire-and-forget `ctx.waitUntil(generateSummary(...))`. The save response returns immediately — the user sees "Saved version <id>" within the existing latency budget.
- The summary writer:
  - Computes a unified diff (3 lines of context) between previous and new content. If no previous version, treats the whole new content as added.
  - Calls Workers AI with the prompt below (model: pick from current CF AI lineup; aim for a fast, cheap, large-enough-context option — e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` if still available, or whatever the current equivalent is at task time).
  - Trims output to ≤200 characters. If the model returns nothing useful or errors out, falls back to `"Minor changes."` rather than failing the row.
  - Writes the summary back to `wiki_versions.summary` for the inserted version id. Best-effort — a write failure logs but doesn't crash the Worker.
- Activity feed route at `<tenant>.<apex>/activity`:
  - Tenant-admin gated (use the same auth middleware as the existing admin routes).
  - Lists the N most recent `wiki_versions` rows for this tenant's pages, newest first.
  - Each row shows: page title + slug (linked), summary (or `"Minor changes."`), author display name, relative timestamp, raw `+N/-M lines` delta.
  - Server-rendered HTML (same style as the wiki shell, Hono template literal). No SPA work needed for v1.
- Wrangler config: add `[ai]` binding to `wrangler.toml` (`binding = "AI"`).
- Tests: at minimum, a unit test that exercises the diff generator + a smoke test that the activity route returns 401 to unauthenticated requests and 200 with the expected rows to an admin.

## Prompt design

The model should default to "Minor changes." rather than guess. Suggested system message:

```
You summarize wiki page edits for a moderation review feed. You will see a
unified diff of a Markdown wiki page. Describe in 1–2 short sentences what
actually changed, in plain English, for a reviewer who hasn't seen the page.

Rules:
- Describe only edits you are confident about. If the diff is ambiguous,
  consists only of whitespace, only formatting, or you cannot determine
  intent — respond with exactly: Minor changes.
- Do not speculate about author intent. Stick to observable changes.
- Do not add commentary, opinions, or quality judgments.
- Do not quote large chunks. Summarize.
- Maximum 200 characters total.
```

User message: the diff itself, fenced as `diff` for syntax disambiguation.

Implementer judgment call: pass the model the slug + title alongside the diff if it helps grounding, or keep it diff-only to reduce hallucination surface. Defaults to diff-only.

## Relevant files

- `server/wiki/do.ts` — version write happens here (or wherever the editor's save call lands).
- `server/wiki/routes.ts` — add `/activity` route here.
- `packages/db/src/index.ts` — wiki_versions schema + a new helper to update the `summary` column and to list recent versions for a tenant.
- `wrangler.toml` — add `[ai]` binding.
- `server/types.ts` — add `AI: Ai;` to `Env` (Cloudflare's `Ai` type ships with `@cloudflare/workers-types`).

## Constraints

- Privacy: confirmed via Cloudflare's Workers AI policy that inputs/outputs aren't used for training and aren't retained beyond serving the request (https://developers.cloudflare.com/workers-ai/platform/privacy/). No extra trust boundary vs. running on Workers in the first place.
- Cost: tally roughly. Workers AI has a generous free tier and per-call pricing afterward. Per-save calls are small (a diff plus the prompt), so cost should stay well under 1¢ per save at any realistic rate.
- Failure mode is silent. The activity feed shows `"Minor changes."` for any version whose summary failed or hasn't run yet — never block the user's save.
- Don't display the raw AI output without the +N/-M line delta next to it. The deterministic delta is the ground-truth signal; the AI text is a convenience layer on top.
- Generic-code rule: no apex literals in `server/` or `packages/`. Pull tenant info from `c.var.tenant` / `c.var.config`.
