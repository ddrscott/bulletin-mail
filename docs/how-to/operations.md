---
title: "Day-2 operations"
description: "Routine ops, incident triage, capacity, decommissioning a tenant."
---

Day-2 operations for a running BulletinMail instance.

> Stub. Fill in as operational patterns emerge from running the reference instance. Below is the topic outline.

## Routine

- **Daily:** scan `abuse@<apex>` (manually until automated). Check Cloudflare Email Routing logs for anomalies.
- **Weekly:** review DMARC aggregate reports landing at `dmarc@<apex>`.
- **Monthly:** review per-tenant message volume against the configured daily limits; bump limits or follow up with the tenant as needed.

## Incidents

- **Tenant being spammed / spamming:** suspend via `UPDATE tenants SET status='suspended' WHERE slug=?`.
- **Bounce surge to a single domain:** check Email Sending dashboard for IP reputation issues at that domain; coordinate with Cloudflare support.
- **Queue backlog:** inspect dead-letter queue (`wrangler queues consumer ...`); diagnose root cause before redriving.

## Backups and disaster recovery

- D1 snapshots: schedule `wrangler d1 export` to R2 nightly.
- R2 attachments: enable bucket lifecycle / replication per your tolerance.
- DNS: keep an offsite copy of the zone file.

## Capacity planning

- 100 tenants × 5 groups × 50 members × 4 messages/week ≈ 500k sends/month — fits comfortably in Workers Paid + Email Sending baseline.
- Re-evaluate when any of those numbers grows ~5x.

## Decommissioning a tenant

- Tenant requests data export.
- Email all admins a 30-day notice.
- After grace period: `DELETE FROM tenants WHERE slug=?` (cascades).
- Free up the slug after 90 days (avoid surprise re-use).
