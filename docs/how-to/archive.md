---
title: "Browse the list archive"
description: "Read past list traffic on the web — threads, messages, attachments — and control who can see what."
---

Every message delivered through a list is archived and browsable at your organization's subdomain. Members who joined late, deleted an email, or want to find "that thread about the fall festival" can read everything their lists have carried.

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
