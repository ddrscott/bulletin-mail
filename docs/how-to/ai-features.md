---
title: "Enable AI features"
description: "Turn on promote-to-wiki, red-link page generation, and wiki hero images — each behind its own feature flag, all off by default, with a per-tenant daily cap."
---

BulletinMail ships three optional AI features. They are the **only part of the stack that can meaningfully consume paid resources**, so all three are off by default and each has its own flag — a curious congregation can't accidentally generate cost.

| Feature | Flag | What it does |
| ------- | ---- | ------------ |
| Promote to wiki | `features.ai.promoteToWiki` | Admins/moderators get a **Promote to wiki** button on archive threads. Workers AI distills the thread into a draft wiki page (title from the subject, body citing the `/t/<thread-id>` permalink). The draft opens in the wiki editor for human review — **nothing is published until a person clicks Save**. |
| Red-link autogen | `features.ai.wikiAutogen` | When a signed-in editor follows a `[[red link]]` to a missing page, the placeholder offers **Generate a draft with AI**. One click writes a first draft in the wiki's voice, seeding `[[links]]` to existing pages, saved with an `AI-generated draft` revision note for review. Generation is always an explicit POST — a bare page view (crawler, prefetch) never triggers it. |
| Hero images | `features.ai.wikiHeroImages` | A **Hero image** action in the wiki editor (and, when autogen is also on, on generated pages) creates an illustration via Workers AI, stores it in the wiki's R2 image space, and inserts it at the top of the page. |

Generated pages are indexed by [unified search](/how-to/archive/) like any other page, and every generation is recorded in `audit_log` (`ai.promote_to_wiki`, `ai.wiki_autogen`, `ai.wiki_hero_image` — who, what, which model).

## Prerequisites

The web Worker must have the Workers AI binding (`[ai] binding = "AI"` in `wrangler.toml` — present by default in this repo). If your deploy removed it, **the features hide entirely** even with flags on: no buttons, no broken links, zero AI calls. This double gate (flag AND binding) is the contract.

## Turn features on

In `deployments/<your-apex>/instance.config.json`:

```json
{
  "ai": {
    "dailyGenerationCap": 20,
    "textModel": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "imageModel": "@cf/black-forest-labs/flux-1-schnell"
  },
  "features": {
    "ai": {
      "promoteToWiki": true,
      "wikiAutogen": false,
      "wikiHeroImages": false
    }
  }
}
```

Then re-render and deploy:

```sh
pnpm render-wrangler --instance <your-apex>
pnpm deploy
```

Run the migration that creates the usage counter (once):

```sh
pnpm db:migrate   # applies 0009_ai_usage.sql
```

## The daily cap

`ai.dailyGenerationCap` (default **20**) is the maximum number of generation calls — text or image, combined — **per tenant per UTC day**, counted in the `ai_usage` D1 table. When the cap is hit, the UI shows a clear "limit reached" message and no model call is made; the counter resets at midnight UTC. Autogen with hero images enabled consumes **two** units per page (one text, one image).

The `ai_usage` rows are never deleted — they double as a coarse per-tenant usage history you can query:

```sql
SELECT day, count FROM ai_usage WHERE tenant_id = ? ORDER BY day DESC LIMIT 30;
```

## Model configuration

Model ids live in config, not code, so you can react to [Workers AI model deprecations](https://developers.cloudflare.com/workers-ai/models/) without a source change. Any Workers AI text-generation model that accepts a `messages` array works for `textModel`; `imageModel` supports both response shapes Workers AI uses for text-to-image (base64 `image` field and raw binary).

## Honest cost notes

Read [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before enabling — prices and free allocations change, and **you are the operator; the bill is yours**.

- **Order of magnitude, not a promise:** a promote or autogen call sends a few thousand input tokens and generates up to ~2k output tokens on a 70B-class model; an image call is one image. At the default cap of 20 calls/day per tenant, a single-org deploy stays small — typically within or near Workers AI's free daily allocation, and cents-per-day territory beyond it. A multi-tenant instance multiplies that by every tenant you enable it for.
- The cap is your real protection. Set it to what you would be comfortable paying for **every day**, because a determined moderator can hit it daily.
- Text models are metered per token; image models per image (or per step). The 70B default favors quality; swapping `textModel` to a smaller model (e.g. an 8B) cuts cost roughly proportionally at some quality loss.
- The wiki's edit summaries and unified-search embeddings (earlier features) also use Workers AI but are orders of magnitude cheaper per call; they are not governed by these flags or the cap.
- Privacy note: per Cloudflare's documentation, Workers AI does not retain prompts or outputs for model training, but thread content **is** sent to the model when someone clicks Promote. If your lists carry sensitive pastoral content, consider leaving `promoteToWiki` off or briefing moderators.

## Review discipline

The features are drafting tools, not authors:

- **Promote** never saves anything — the reviewer edits in the wiki editor and decides.
- **Autogen** saves immediately (that's what makes red links useful), but the version note marks it AI-generated, the activity feed shows the full diff, and a revert is one click.
- Hero images only become part of a page when the human saves the markdown referencing them.
