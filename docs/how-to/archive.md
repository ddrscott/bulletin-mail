---
title: "Browse the list archive"
description: "Read past list traffic on the web — threads, messages, attachments — post replies and new threads, and control who can see what."
---

Every message delivered through a list is archived and browsable at your organization's subdomain. Members who joined late, deleted an email, or want to find "that thread about the fall festival" can read everything their lists have carried. Members who prefer the web can also post from it — replies and new threads composed in the browser travel the same email pipeline as everything else.

## Where the archive lives

| Page | URL |
| ---- | --- |
| List index | `https://<tenant>.<apex>/archive` |
| Threads in a list | `https://<tenant>.<apex>/archive/<group>` |
| A single thread (permalink) | `https://<tenant>.<apex>/t/<thread-id>` |

In single-tenant deployments (`features.singleTenant`) the same paths are served at the apex domain itself.

Thread URLs are stable — safe to bookmark, paste into a bulletin, or link from a digest.

## Sign in as a member

The archive requires sign-in. Members use the same passwordless flow moderators do:

1. Visit `/archive` (or any thread link). You'll be redirected to the sign-in page.
2. Enter the email address you're subscribed with. If it matches an active subscription, you'll receive a sign-in email.
3. Click the link in the email, **or** paste the 6-digit code from the email into the form on the "check your email" page (useful when a corporate mail filter rewrites links).

Sessions last 7 days per browser. Unsubscribing revokes archive access on the next request — no session cleanup needed.

Moderators and tenant admins sign in through the same page and see every list.

## What a member can see

Group-level visibility follows the `archive_visibility` setting on each list (admin UI → group → Settings):

- **`members`** (default) — only active members of that list can read its archive.
- **`public`** — any signed-in member of the *organization* can read it, even without being subscribed to that list. This is tenant-public, not internet-public.
- **`none`** — the list is hidden from the archive for everyone, including admins.

## Post from the web

Signed-in members with posting permission see a **reply box** at the bottom of every thread and a **"Start a new thread" form** at the bottom of each list's thread page. A web post is not a separate content type: it is built into a normal list email (same From rewrite for DMARC alignment, same `In-Reply-To`/`References` threading, same subject-prefix handling, same `List-Unsubscribe` headers) and delivered to every member's inbox — email recipients and web readers see one conversation. The post appears in the archive immediately.

Who gets the form follows the list's `posting_policy`, with exactly the same rules the email path enforces:

- **`open`** — any signed-in viewer can post.
- **`members`** (default) — active members of the list.
- **`announce_only`** — only members with the moderator or authorized-sender role.
- **`moderated`** — not yet supported (the email path bounces these too until the moderation queue ships); no form is shown.

Notes and limits:

- Plain text only for now — no attachments, no rich formatting. URLs are auto-linked when rendered.
- **Rate limit:** at most 5 posts per 10 minutes per member (counting their emailed posts too).
- **Human check:** when the operator has configured Cloudflare Turnstile (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`, same keys as admin sign-in), the post forms include the widget and posts without a valid token are refused.
- Delivery fans out directly from the web Worker's email binding — no Queues involvement, so web posting works on the free tier in single-tenant mode.

## Message rendering and privacy

- HTML email bodies are sanitized before display: scripts, styles, iframes, forms, and event handlers are stripped.
- Remote images are blocked by default, which also kills tracking pixels. Inline (attached) images still display.
- Email addresses are obfuscated in rendered pages (`scott@e…`) — sender display names are shown when available.
- Attachments are listed under each message and download through an auth-checked route; nothing in R2 is publicly reachable.
- Messages that were rejected or are held for moderation never appear.

## Operator notes

- The archive reads only D1 and R2 — no Queues involvement, free-tier friendly.
- The web Worker needs the `ATTACHMENTS` R2 binding (same bucket the inbound Worker writes). Declared in the root `wrangler.toml`; re-run `pnpm render-wrangler --instance <your-apex>` and redeploy after upgrading.
- Run migrations to pick up `member_magic_links`: `pnpm db:migrate`.
- Legacy `/g/<tenant>/<group>` links on the apex 302 to the tenant-subdomain archive.
