---
title: "Privacy Notice"
description: "What we collect, what we don't, and what we do with it. No tracking. No sale of data."
template: doc
tableOfContents: false
---

**Effective:** May 26, 2026
**Service:** BulletinMail at `bulletinmail.org`
**Provider:** Left Join Studio, Inc. ("LJS")

## The short version

We will never sell your data or your subscribers' data to third parties. We use first-party analytics only — no third-party trackers, no ad networks, no cross-site cookies. Member data belongs to the organization that collected it.

## What we collect

To operate BulletinMail, we store:

- **Administrator accounts.** Email address, optional display name, and the timestamps of sign-in events. Authentication is by emailed magic link — we do not store passwords.
- **Tenant content.** Your lists, subscribers, messages, archives, wiki pages, and uploaded images.
- **Subscriber data.** Email addresses, optional names, subscription status, and message-delivery state (sent, bounced, unsubscribed). This is data your organization gave us in order for us to deliver mail on its behalf.
- **Mail in transit.** Inbound messages to your list addresses pass through our infrastructure to be fanned out to subscribers.
- **Operational logs.** Request logs, error traces, and delivery metadata sufficient to debug and operate the service. These are kept for a rolling window (typically 30 days) and then discarded.

## What we don't collect

- No third-party analytics, advertising pixels, or social-network trackers.
- No fingerprinting beyond what is required to authenticate a session.
- No cross-site cookies. The session cookie is host-scoped and necessary to the service.

## First-party analytics

We use Cloudflare's first-party analytics to measure aggregate page performance — page load time, error rate, traffic patterns. These analytics do not track individuals across sites and do not feed any advertising system.

## How we use data

We use the data above only to:

- Deliver mail and operate the service.
- Authenticate administrators.
- Diagnose and fix problems.
- Aggregate, non-identifying performance reporting.

We do **not** sell, rent, or trade personal data. We do **not** use member data to train AI models or for any purpose unrelated to operating the service on behalf of your organization.

## Subprocessors

The service runs on Cloudflare's developer platform. Cloudflare processes data on our behalf as a subprocessor under its [Data Processing Addendum](https://www.cloudflare.com/cloudflare-customer-dpa/). No other subprocessors handle member data.

## Your rights

If you are an **administrator** of a tenant:

- You can export or delete your tenant's data at any time using the admin tools or the CLI.
- You can request that LJS permanently delete your account and the tenant's data by emailing **legal@bulletinmail.org**.

If you are a **subscriber** on a list operated by an organization using BulletinMail:

- Every message we send carries a one-click unsubscribe link and a `List-Unsubscribe` header.
- The organization that added you to the list is the data controller for your subscription. To remove your data entirely, contact that organization. If they don't respond, you may contact **legal@bulletinmail.org** and we will assist.

## Security

Mail is delivered over TLS where the receiving server supports it. Administrative sessions are authenticated by short-lived magic-link tokens. We follow current best practices for secret handling, and we publish the source so anyone can verify.

No system is perfectly secure. If you discover a security issue, please report it to **legal@bulletinmail.org** before public disclosure.

## Data retention

- **Subscriber and content data:** retained as long as your tenant exists, or until you delete it.
- **Authentication tokens:** expire within minutes.
- **Operational logs:** rolling 30-day window.

If your tenant is suspended or closed, your data is retained for 30 days to allow recovery, then permanently deleted.

## Children

BulletinMail is not designed for use by children under 13, and we do not knowingly collect data about them. If you believe we have, contact **legal@bulletinmail.org** and we will delete it.

## Changes

We will post any material changes to this notice on `bulletinmail.org` at least 14 days before they take effect.

## Contact

Privacy questions, deletion requests, security reports: **legal@bulletinmail.org**
