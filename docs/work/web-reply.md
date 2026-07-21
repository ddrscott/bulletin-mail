# Web reply — post from the web into the list pipeline

Part 2 of 5 of the **community-hub roadmap** (see `archive-browser.md` for the vision). With the archive browser shipped, this task turns it into a functioning forum: signed-in members can reply to threads (and start new ones) from the web. A web post is not a separate content type — it is formatted as an RFC-compliant email and injected into the existing list pipeline, so email recipients and web readers see the same conversation.

## Problem

The archive is read-only. Members who prefer the web (or found a thread via search) must switch to their mail client to participate. Discourse-style participation requires a reply box — but building a parallel "forum post" path would fork the data model. Injecting into the mail pipeline keeps one source of truth.

## Acceptance Criteria

- Thread view gains a reply form (signed-in members with post permission on that group).
- Group index gains a "new thread" form (subject + body).
- Submitting builds a proper MIME message via `packages/mime`:
  - `From:` the member's list address identity (respecting the DMARC-alignment model — from a subdomain of the apex, consistent with how relayed mail is rewritten).
  - Correct `In-Reply-To`/`References` so mail clients thread it with the original.
  - Subject prefix handling identical to mailed replies.
- The message flows through the same fan-out/delivery path as an emailed post (moderation queue included: if the group is moderated, web posts land in `moderation_queue` like any other).
- The web post appears in the archive immediately (or after moderation approval) — same ingest path, no special casing.
- Anti-abuse: Turnstile on the post form for defense in depth (pattern already established in admin sign-in), plus a simple per-member rate limit.
- Plain-text posting is sufficient for v1; optional minimal Markdown → HTML if trivially safe.
- Works in single- and multi-tenant modes; instance-leakage check passes.

## Relevant Files

- `workers/community/` (created in archive-browser task) — forms + POST endpoints.
- `packages/mime/` — message building, threading, subject prefix.
- `workers/sender/src/index.ts` — existing fan-out/delivery path to reuse.
- `workers/inbound/src/index.ts` — understand ingest so web posts persist identically.
- `packages/db/migrations/` — `messages`, `deliveries`, `moderation_queue`.

## Constraints

- Depends on: archive-browser (part 1). Do not start before it exists.
- One pipeline: no forum-only posts table. If it didn't go through the mail path, it doesn't exist.
- At ≤100-member scale, fan-out must not require the paid Queues plan in single-tenant/free mode — reuse whatever non-Queues path exists or chunked `waitUntil`/DO alarm if needed.
- No emojis in UI; Lucide icons only.
