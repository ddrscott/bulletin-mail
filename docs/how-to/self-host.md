# Self-hosting BulletinMail

This guide walks an operator through deploying their own BulletinMail instance under their own apex domain on their own Cloudflare account. Estimated time, end-to-end: ~90 minutes if you already have a Cloudflare account.

You'll use BulletinMail's source largely unmodified. Everything specific to your deployment lives in **one file**: `deployments/<your-apex>/instance.config.json`.

> The reference instance at `bulletinmail.org` follows exactly the steps below. If something in this doc is unclear, `deployments/bulletinmail.org/` is the worked example.

---

## 0. Prerequisites

- A Cloudflare account (Workers Paid plan recommended — Email Sending limits are higher).
- An apex domain you control, added to your Cloudflare account as a Zone (its nameservers should point at Cloudflare).
- Node.js 20+ and pnpm 9+.
- `wrangler` authenticated to your account (`pnpm dlx wrangler login` from inside this repo, or `wrangler login` if installed globally).

> **Verify before you start (PRD §17, Phase 0 blockers):**
> 1. Confirm Cloudflare Email Routing supports wildcard `*@*.<your-apex>` catch-all under a single zone. If your account/plan doesn't, your only path is the slug-prefix model (PRD §6 rejected alternative).
> 2. Note the Email Sending rate limits available on your plan.

---

## 1. Clone the repo and install dependencies

```sh
git clone https://github.com/ddrscott/bulletin-mail.git
cd bulletinmail
pnpm install
```

---

## 2. Create your deployment overlay

```sh
cp -R deployments/bulletinmail.org deployments/<your-apex>
# e.g. cp -R deployments/bulletinmail.org deployments/lists.example.org
```

Edit `deployments/<your-apex>/instance.config.json`:

- `apexDomain` — your apex, e.g. `lists.example.org`
- `adminDomain` — e.g. `app.lists.example.org`
- `productName`, `productNameShort`, `tagline` — what your members see in From-headers and footers
- `archiveUrlTemplate`, `unsubscribeUrlTemplate`, `adminUrl` — substitute your apex
- `operator.legalName`, `operator.mailingAddress` — **required for CAN-SPAM compliance**, appears in email footers
- `operator.contactUrl` — link in the footer for support
- `additionalReservedSlugs` — any subdomains you plan to use later (`donate`, `events`, your org name, etc.)

The full schema is in [`packages/shared/instance.config.schema.json`](../packages/shared/instance.config.schema.json). Editors that respect `$schema` (VSCode, JetBrains) will autocomplete.

---

## 3. DNS records on your apex

Add these to the zone for `<your-apex>` in Cloudflare. Substitute your domain for `<your-apex>` throughout.

```
; Inbound mail — system addresses (apex)
<your-apex>.              MX  10  <route-target-from-cloudflare-email-routing>

; Inbound mail — tenant lists (wildcard subdomains)
*.<your-apex>.            MX  10  <route-target-from-cloudflare-email-routing>

; HTTP routing for apex + every tenant subdomain
; Both records are proxied (orange-cloud) so the wildcard Worker route can
; intercept HTTP. Single web Worker handles all of them — see PRD §6.5.
<your-apex>.              A    192.0.2.1   ; placeholder; CF resolves via Worker route
*.<your-apex>.            CNAME <your-apex>.

; Outbound auth
<your-apex>.              TXT  "v=spf1 include:_spf.mx.cloudflare.net ~all"

; DKIM — managed automatically by Cloudflare Email Sending after step 5
*._domainkey.<your-apex>. TXT  (provisioned by Cloudflare)

; DMARC
_dmarc.<your-apex>.       TXT  "v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@<your-apex>; ruf=mailto:dmarc@<your-apex>; pct=100; adkim=r; aspf=r"
```

Notes:
- The exact MX target is shown in your Cloudflare dashboard under **Email → Email Routing**.
- Start DMARC at `p=quarantine`. Move to `p=reject` after at least 7 days of clean aggregate reports.
- Keep SPF at `~all` (soft fail). Don't switch to `-all` until DMARC is at `quarantine` or stricter and reports are clean.

---

## 4. Cloudflare resource creation

From the repo root:

```sh
# D1 database
wrangler d1 create bulletinmail
# → copy the database_id it prints; you'll need it in step 6.

# R2 bucket
wrangler r2 bucket create bulletinmail-attachments

# Queues (send + dead-letter)
wrangler queues create bulletinmail-send
wrangler queues create bulletinmail-send-dlq
```

---

## 5. Email Routing + Email Sending setup

In the Cloudflare dashboard for `<your-apex>`:

1. **Clean the DNS first.** Email Routing's enable step refuses to proceed if there are *any* existing SPF (TXT `v=spf1`) records on the apex — it wants to add its own. Delete every pre-existing SPF record under DNS → Records. (Real-world gotcha: a zone you registered through the Cloudflare Registrar often comes with a default `v=spf1 -all`; both that and any registrar-added `v=spf1 ~all` must go.)
2. **Email → Email Routing → Get started.** Cloudflare will add the apex MX records (`route1.mx.cloudflare.net`, etc.) and its own SPF. Enable routing.
3. **Add the wildcard MX.** Email Routing only adds MX for the apex itself. For tenant subdomains, manually add:
   ```
   *.<your-apex>.   MX  10  route1.mx.cloudflare.net.
   *.<your-apex>.   MX  20  route2.mx.cloudflare.net.
   *.<your-apex>.   MX  30  route3.mx.cloudflare.net.
   ```
   (See PRD §17 #1.)
4. **Email Routing → Routing rules → Create catch-all rule.** Action: *Send to a Worker*, select `bulletinmail-inbound`. Save.
5. **Email → Email Sending → Enable for this zone.** Cloudflare will provision DKIM keys and verify SPF. Sending from the apex and any subdomain becomes available.

> If Email Sending isn't available on your plan, BulletinMail can be adapted to send via Resend or SES. The sender Worker is the only place that calls `env.EMAIL.send`; swapping providers is contained.

---

## 6. Wire up the D1 database_id

Open `workers/inbound/wrangler.toml`, `workers/sender/wrangler.toml`, `workers/web/wrangler.toml`. In each, replace:

```toml
database_id = "PLACEHOLDER_LOCAL_DEV"
```

with the `database_id` from step 4. *(Future improvement: have `render-wrangler` substitute this automatically.)*

---

## 7. Set secrets

```sh
# Each must be set per-Worker. Use 32+ random hex bytes.
# The same UNSUB_TOKEN_PEPPER value must be set in both workers (sender + web)
# so tokens minted by one are verifiable by the other.
PEPPER=$(openssl rand -hex 32)
echo "$PEPPER" | wrangler secret put UNSUB_TOKEN_PEPPER --name bulletinmail-sender
echo "$PEPPER" | wrangler secret put UNSUB_TOKEN_PEPPER --name bulletinmail-web

# Admin sessions (Phase 2; safe to set now).
openssl rand -hex 32 | wrangler secret put ADMIN_API_JWT_SECRET --name bulletinmail-web
```

---

## 8. Render Worker configs from your overlay

```sh
pnpm render-wrangler --instance <your-apex>
```

This produces `workers/*/wrangler.generated.toml` with `[vars]` populated from your `instance.config.json`. The `.generated.toml` files are gitignored.

---

## 9. Run database migrations

```sh
pnpm db:migrate
# Equivalent to:
#   wrangler d1 execute bulletinmail --file packages/db/migrations/0001_init.sql
```

---

## 10. Deploy the Workers

```sh
pnpm --filter "@bulletinmail/*" deploy
```

Or individually:

```sh
pnpm --filter @bulletinmail/inbound deploy   # Email Routing handler
pnpm --filter @bulletinmail/sender  deploy   # Queue consumer
pnpm --filter @bulletinmail/web     deploy   # ALL HTTP — apex + admin + tenant subdomains
```

The web worker's wildcard route (`*<your-apex>/*`) covers the apex AND every tenant subdomain in a single declaration — there is no per-tenant route to add when you create new tenants. Browser traffic to `https://firstpresby.<your-apex>/` reaches the web worker automatically.

---

## 11. Point Email Routing's catch-all at the inbound Worker

Back in the Cloudflare dashboard:

- **Email Routing → Routing rules → Catch-all → Edit.** Action: **Send to a Worker**, select `bulletinmail-inbound`. Save.

---

## 12. Create the first tenant + admin

```sh
pnpm cli create-tenant \
  --slug myorg \
  --name "My Organization" \
  --admin-email you@example.com
```

Then a group:

```sh
pnpm cli create-group \
  --tenant myorg \
  --name announcements \
  --display "Announcements" \
  --policy announce_only \
  --prefix "[Announcements]"
```

Then a member:

```sh
pnpm cli add-member \
  --tenant myorg \
  --group announcements \
  --email you@example.com
```

---

## 13. Send a test email

Send from any external account (Gmail, Apple Mail, ...) to:

```
announcements@myorg.<your-apex>
```

You should receive it back within seconds, with proper threading headers and a working one-click unsubscribe button in Gmail's UI.

If the message doesn't arrive within a minute, check:

- `wrangler tail bulletinmail-inbound` — is the message hitting the Worker?
- `wrangler tail bulletinmail-sender` — is the queue consumer picking it up?
- `wrangler tail bulletinmail-web` — for HTTP traffic (unsubscribe clicks, bounce events).
- Cloudflare dashboard **Email Routing → Logs**.
- Cloudflare dashboard **Queues → bulletinmail-send → Dead-letter**.

---

## 14. Verify standards compliance

Send a message from your apex to [`test@mail-tester.com`](https://www.mail-tester.com) and read the score. **A 10/10 is required before opening the instance to non-test users** (PRD §11 Phase 1 acceptance criteria).

Set up DMARC report ingestion: aggregate reports will land at `dmarc@<your-apex>`. After 7 days of clean reports, move DMARC from `p=quarantine` to `p=reject`.

---

## Ongoing operations

- **Logs:** `wrangler tail <worker-name>`
- **D1 console:** `wrangler d1 execute bulletinmail --command "SELECT ..."`
- **Suspending a tenant:** `pnpm cli ... ` *(Phase 1)* or set `tenants.status = 'suspended'` in D1.
- **Adding new reserved subdomains later:** edit `deployments/<your-apex>/instance.config.json`'s `additionalReservedSlugs`, re-render, re-deploy. Existing tenants on those subdomains are not affected.

See [`operations.md`](operations.md) for the operator runbook.

---

## Updating to a new release

```sh
git fetch origin
git checkout v0.X.0
pnpm install
pnpm db:migrate        # if migrations are present
pnpm render-wrangler --instance <your-apex>
pnpm --filter "@bulletinmail/*" deploy
```

`CHANGELOG.md` calls out any breaking changes that require manual operator action.

---

## What did I just deploy?

A 90-second skim of `PRD.md` (especially §4 Architecture and §12 Cross-Phase Invariants) will give you the mental model. Reading the full PRD takes ~30 minutes and is the single best investment in becoming an effective operator.
