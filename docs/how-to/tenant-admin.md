---
title: "Administer your tenant"
description: "Sign in to the tenant admin, create lists, add members, approve subscribe requests, and manage your team."
---

Day-to-day tenant administration — creating lists, adding people, approving subscribe requests — happens in the web admin at your tenant's subdomain:

```
https://<tenant>.<apex>/admin
```

No CLI or DNS knowledge required. (Operators can also do all of this from the command line — see the [CLI reference](/docs/reference/cli/).)

## Before you start

You need a tenant and an admin account on it. How you get one depends on who runs the instance:

- **Hosted instance:** the site admin creates your tenant (from `https://<apex>/admin`) with your email as the first admin. You receive a welcome email with a sign-in link and your admin URL.
- **Self-hosting:** create the tenant yourself with `pnpm cli create-tenant --slug <slug> --name "<Display Name>" --admin-email <you@example.org>`, or from the site-admin UI at `https://<apex>/admin`.

## Sign in

1. Open `https://<tenant>.<apex>/admin`.
2. Enter your email and click **Send code**.
3. Check your inbox — the email contains a one-time sign-in link and a 6-digit code. Click the link, or type the code into the form.

The link and code expire after 15 minutes; use **Resend code** if you missed the window. Only emails on the tenant's team receive codes, and the form never reveals whether an address matched.

## Create a list

From the admin home page, click **New group**.

| Field | What it does |
|-------|--------------|
| List name | Local-part of the list's email address — lowercase letters, digits, dashes (e.g. `announcements` → `announcements@<tenant>.<apex>`). |
| Display name | Human name shown to recipients (e.g. `Announcements`). |
| Description | Optional. Shown on the public subscribe page. |
| Who can post? | `Members can post` · `Open` (anyone) · `Moderated` (admin approves each post) · `Announce only` (moderators and sender-only roles). |
| Reply-to | `List` (replies go to everyone) or `Sender` (replies go privately to the author). |
| Subject prefix | Optional, e.g. `[Announcements]`. Prepended to every subject line. |
| Archive visibility | `Members-only` · `No archive` · `Public`. Public archives are visible to anyone with the URL, including search engines — the form asks you to confirm. |

Click **Create group**. The list address works immediately.

## Add members yourself

Open the group, then use the **Members** tab.

To add one person: enter their email, an optional display name, pick a role, and click **Add member**.

Members you add go through **double opt-in**: they receive a confirmation email and show as *Awaiting confirmation* until they click **Yes, subscribe me**. They receive no list mail before confirming, and the email includes a decline link.

### Bulk import

Under **Bulk import (paste emails)** on the same tab:

1. Paste addresses — one per line, comma/semicolon separated, or `Name <email>` format.
2. Click **Preview**. The dry run shows what will be added, what's already a member, and what's invalid — nothing is written yet.
3. Click **Add all**.

Bulk-imported members get the `Member` role, and each receives the same confirmation email.

## Let people subscribe themselves

Every list has a public subscribe page:

```
https://<tenant>.<apex>/join/<list-name>
```

The URL is shown on the group's **Pending** tab. Share it in a bulletin, text message, or on your site — it's a plain server-rendered form (name, email, optional note to the moderators) that loads fast on phones.

Submissions land on the **Pending** tab for review:

- **Approve** — the person becomes an active member immediately (no extra confirmation email; they already opted in by submitting the form).
- **Reject** — the request is closed. Your optional note is kept for moderators and is *not* sent to the requester.

To require agreement to a statement (a code of conduct, a privacy notice) before subscribing, fill in **Subscribe-form statement** on the group's **Settings** tab. The form then shows the statement with a required "I have read and agree" checkbox.

## Manage roles, statuses, and removal

Each membership has a per-list role, changeable from the dropdown on the **Members** tab:

| Role | Meaning |
|------|---------|
| Member | Receives mail; may post if the posting policy allows members. |
| Moderator | May post to announce-only lists. |
| Sender only | May post to announce-only lists but is not a regular recipient. |

Status column:

| Status | Meaning |
|--------|---------|
| Active | Receiving mail. |
| Awaiting confirmation | Added by an admin; hasn't clicked the confirm link yet. |
| Bouncing | Deliveries are failing (bounce count shown). |
| Unsubscribed | No longer receiving mail. |

**Remove** marks the member unsubscribed — the row is kept for audit and can be re-activated by re-adding, but mail stops immediately. Members can also unsubscribe themselves at any time via the link in every message footer.

## Change list settings

The group's **Settings** tab covers display name, description, posting policy, reply-to, subject prefix, archive visibility, max incoming message size (Cloudflare caps inbound at 25 MiB), and the subscribe-form statement.

The **list name** (email local-part) is read-only once the list has members or messages — changing it would break threading on existing replies. Rename and delete live in the **Danger zone** and are only available while the list is empty; delete requires typing the list name to confirm and cannot be undone.

## Invite your team

Open **Team** from the admin home page. Enter an email, pick a role, click **Invite** — they're emailed a sign-in link immediately.

| Role | Can do |
|------|--------|
| Admin | Everything: lists, members, settings, team management. |
| Moderator | Edit the tenant wiki and approve/reject subscribe requests. |

Safeguards: you can't remove yourself, and you can't demote or remove the only admin.

## Send a message to the list

There's nothing to configure — email `<list-name>@<tenant>.<apex>` from your subscribed address, and it fans out to every active member with the subject prefix applied and threading intact. Who may post is governed by the list's posting policy. Past traffic is browsable per the archive visibility setting — see [Browse the list archive](/docs/how-to/archive/).
