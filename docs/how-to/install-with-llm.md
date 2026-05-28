---
title: "Install BulletinMail with an LLM"
description: "Hand this guide to ChatGPT, Claude, or another shell-capable LLM agent. Given a Cloudflare account and a domain, the agent can bring up a single-tenant BulletinMail deployment end-to-end."
---

This is the **LLM-operated installer**. The reader is a coding agent (Claude Code, ChatGPT with shell, Cursor agent) — not a human. The agent has shell + filesystem + a Cloudflare account belonging to the human user. Every step below specifies exactly what to run, what success looks like, and when to stop and ask the human.

If you are a human, read [`self-host.md`](/how-to/self-host/) instead — it's the same content with more rationale.

If you are an LLM, **execute steps in order. Do not skip ahead. After every step, verify the success criterion before moving on. If a step fails, do not retry blindly — re-read the failure and ask the human for help.**

---

## Mode

This guide targets the **single-tenant deployment variant**: one organization, one apex, one wiki, mail on `mail.<apex>`. It's the simplest deploy and the one new operators almost always want first. Multi-tenant deployments (one Cloudflare account hosting many orgs on `<slug>.<apex>` subdomains) are covered in the human guide.

The end state after this guide:

- `https://<apex>/` — the org's wiki home + admin SPA at `/admin/`
- `<group>@mail.<apex>` — list posting addresses
- `noreply@mail.<apex>` — system mail (sign-in links etc.)
- One Cloudflare account, one apex zone, one bundled Worker, one D1 database, one R2 bucket, two queues.

---

## STEP 0 — Inputs to gather from the human

Before doing anything else, get these from the human user. Quote them back to confirm before proceeding.

| Input | What it is | How to ask |
|---|---|---|
| `APEX` | The apex domain that will host the install, e.g. `lists.acme.org` | "What domain will you use? It must be a real domain you control." |
| `CF_ACCOUNT_ID` | Cloudflare account ID | "I need your Cloudflare account ID. You can find it in the right sidebar of the Cloudflare dashboard, or run `wrangler whoami`." |
| `OPERATOR_LEGAL_NAME` | The legal entity (a company, nonprofit, or individual) that will appear in CAN-SPAM footers | "What's the legal name of the entity that will operate this list? This goes in every outbound email footer." |
| `OPERATOR_MAILING_ADDRESS` | Physical postal address for CAN-SPAM | "What's the postal mailing address you want shown in email footers? Required by law." |
| `OPERATOR_CONTACT_URL` | Where members can reach you, e.g. `https://acme.org/contact` | "What URL should the footer link to for support?" |
| `PRODUCT_NAME` | Human-readable name shown in `From:` and the wiki header, e.g. `"Acme Lists"` | "What should the lists be called in the From line and the website header?" |
| `PRODUCT_NAME_SHORT` | Short form for tight UI slots, e.g. `"Acme"` | "Short version of that name (2 words max)?" |

**Verify the domain is on the user's Cloudflare account** before continuing. If it's not in their Cloudflare zone list, stop and tell them to add the zone first via the Cloudflare dashboard — that requires UI work an agent can't reliably do.

**Success criterion:** all 7 values captured. No placeholders.

---

## STEP 1 — Verify tooling

Run these and confirm each succeeds:

```sh
node --version    # must be >= 20.0.0
pnpm --version    # must be >= 9.0.0
git --version
wrangler --version
```

If `wrangler` is missing, install it: `pnpm add -g wrangler@^3.90.0`.

Verify the user is logged into Wrangler:

```sh
wrangler whoami
```

If this fails with an auth error, stop and tell the human:

> Run `wrangler login` in your terminal. It opens a browser for OAuth — I can't do that for you. Come back when you see your email in `wrangler whoami`.

**Success criterion:** `wrangler whoami` prints the user's email and at least one account.

---

## STEP 2 — Clone the repo

```sh
git clone https://github.com/ddrscott/bulletin-mail.git
cd bulletin-mail
pnpm install
```

**Success criterion:** `pnpm install` exits 0. No lockfile changes (you didn't add deps).

---

## STEP 3 — Create the deployment overlay

The overlay lives at `deployments/<APEX>/instance.config.json`. Create it from the example:

```sh
mkdir -p deployments/<APEX>
cp instance.config.example.json deployments/<APEX>/instance.config.json
```

Edit `deployments/<APEX>/instance.config.json`. Replace the example values with the inputs from STEP 0, and set the single-tenant flag + mail subdomain. The final file should look like this:

```json
{
  "$schema": "../../packages/shared/instance.config.schema.json",

  "apexDomain": "<APEX>",
  "productName": "<PRODUCT_NAME>",
  "productNameShort": "<PRODUCT_NAME_SHORT>",
  "tagline": "Mailing lists for our organization",

  "supportAddress": "support",
  "abuseAddress": "abuse",
  "dmarcAddress": "dmarc",
  "noreplyAddress": "noreply",
  "unsubscribeAddressPrefix": "unsubscribe+",

  "mailSubdomain": "mail",

  "archiveUrlTemplate": "https://<APEX>/g/{tenant}/{group}",
  "unsubscribeUrlTemplate": "https://<APEX>/u/{token}",

  "additionalReservedSlugs": [],
  "minSlugLength": 3,
  "maxSlugLength": 40,

  "defaultDailyMessageLimitPerTenant": 1000,
  "defaultMaxRecipientsPerGroup": 500,

  "operator": {
    "legalName": "<OPERATOR_LEGAL_NAME>",
    "mailingAddress": "<OPERATOR_MAILING_ADDRESS>",
    "contactUrl": "<OPERATOR_CONTACT_URL>"
  },

  "features": {
    "byoDomainEnabled": false,
    "publicArchivesAllowed": true,
    "signupSelfService": false,
    "singleTenant": true
  }
}
```

Validate it parses by running `pnpm render-wrangler --instance <APEX>` (this also produces `wrangler.generated.toml` you'll use later — that's fine, you'll re-render after Cloudflare resources exist).

**Success criterion:** the JSON file exists, contains no `<...>` placeholders, and `pnpm render-wrangler --instance <APEX>` exits 0.

---

## STEP 4 — Create Cloudflare resources

You need one D1 database, one R2 bucket, two Queues, and one KV namespace. Run these from the repo root. **Capture every `id` / `database_id` value the commands print** — you'll wire them into `cloudflare-resources.json` next.

```sh
wrangler d1 create bulletinmail-<APEX-without-dots>
# → prints { binding = "DB", database_name = "...", database_id = "..." }

wrangler r2 bucket create bulletinmail-<APEX-without-dots>-attachments

wrangler queues create bulletinmail-<APEX-without-dots>-send
wrangler queues create bulletinmail-<APEX-without-dots>-send-dlq

wrangler kv namespace create bulletinmail-<APEX-without-dots>-cache
# → prints id = "..."
```

If any of these fail with "name already exists," the human probably ran this guide before — ask them to either pick a different suffix or run `wrangler d1 delete <name>` etc. before retrying. **Do not delete resources on your own initiative.**

Now create `deployments/<APEX>/cloudflare-resources.json` with the IDs you captured:

```json
{
  "account_id": "<CF_ACCOUNT_ID>",
  "d1": {
    "DB": {
      "database_name": "bulletinmail-<APEX-without-dots>",
      "database_id": "<DATABASE_ID_FROM_WRANGLER>"
    }
  }
}
```

**Success criterion:** all four resources created, no errors. `cloudflare-resources.json` exists with real IDs.

---

## STEP 5 — DNS records

You need these DNS records on the `<APEX>` zone in Cloudflare. Use the Cloudflare API via `wrangler` is not possible for DNS — `wrangler` doesn't manage DNS records. Use the Cloudflare API directly with the human's API token, or stop and ask the human to add them via the dashboard.

If using the API: ask the human for a Cloudflare API token with **Zone:DNS:Edit** permission scoped to the relevant zone. Set it as `CF_API_TOKEN` in your shell, then look up the zone ID:

```sh
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=<APEX>" | jq '.result[0].id'
```

Records to add (the dashboard equivalents are listed in parens):

| Type | Name | Content | TTL | Proxy |
|---|---|---|---|---|
| `A` | `@` (apex) | `192.0.2.1` (placeholder; the Worker route intercepts) | Auto | **Proxied (orange)** |
| `MX` | `mail` | `route1.mx.cloudflare.net` priority 10 | Auto | DNS-only |
| `MX` | `mail` | `route2.mx.cloudflare.net` priority 20 | Auto | DNS-only |
| `MX` | `mail` | `route3.mx.cloudflare.net` priority 30 | Auto | DNS-only |
| `TXT` | `mail` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Auto | DNS-only |
| `TXT` | `_dmarc.mail` | `v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@mail.<APEX>; ruf=mailto:dmarc@mail.<APEX>; pct=100; adkim=r; aspf=r` | Auto | DNS-only |

**DKIM** is provisioned automatically by Cloudflare Email Sending in STEP 6 — don't add `_domainkey` records by hand.

Notice that **mail records target `mail.<APEX>`, not the apex itself.** That's the whole point of the `mailSubdomain` setting: web traffic lives on the apex (`https://<APEX>/`), mail lives on `mail.<APEX>`, and each surface has its own SPF/DMARC.

API example for one record:

```sh
ZONE_ID="<from the lookup above>"
curl -s -X POST \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  --data '{
    "type": "MX",
    "name": "mail.<APEX>",
    "content": "route1.mx.cloudflare.net",
    "priority": 10,
    "ttl": 1
  }'
```

**Success criterion:** all 6 records visible at `dig +short MX mail.<APEX>` and `dig +short TXT mail.<APEX>`. The apex `A` record exists (look it up via the API: `GET /zones/$ZONE_ID/dns_records?name=<APEX>`).

If `dig` doesn't show the records yet, wait 60s and retry. Cloudflare DNS propagation is usually <30s on their own resolvers but TTL-bound elsewhere.

---

## STEP 6 — Enable Cloudflare Email Routing + Sending

This step requires the dashboard. Cloudflare's Email Routing API is incomplete and the enable-routing step in particular can't be done headlessly. Stop here and tell the human:

> Please open the Cloudflare dashboard, navigate to your `<APEX>` zone, then:
>
> 1. **DNS → Records.** Delete any pre-existing SPF (TXT `v=spf1`) records on `mail.<APEX>` other than the one we just added. (Some zones come with a default `v=spf1 -all` from the registrar — Email Routing will refuse to proceed if it conflicts.)
> 2. **Email → Email Routing → Get started.** Walk through the wizard. When it asks where to route catch-all, pick **Send to a Worker** — but the Worker doesn't exist yet, so you may need to come back to this after STEP 9.
> 3. **Email → Email Sending → Enable.** Cloudflare will provision DKIM keys for `mail.<APEX>` automatically.
>
> Tell me when each substep is done.

**Success criterion:** the human confirms Email Routing is enabled on `mail.<APEX>` (or the apex zone, whatever the UI shows) and Email Sending is on. DKIM records appear under `*._domainkey.mail.<APEX>` (verify with `dig TXT default._domainkey.mail.<APEX>` once Cloudflare has had a minute to provision).

---

## STEP 7 — Wire resource IDs into Worker configs

Re-render now that `cloudflare-resources.json` exists:

```sh
pnpm render-wrangler --instance <APEX>
```

This produces `wrangler.generated.toml` and `workers/inbound/wrangler.generated.toml` and `workers/sender/wrangler.generated.toml` with the real D1 / R2 / Queue / KV IDs substituted in.

**Success criterion:** all three `wrangler.generated.toml` files exist. `grep database_id wrangler.generated.toml workers/*/wrangler.generated.toml` shows the real ID from STEP 4, not `PLACEHOLDER_LOCAL_DEV`.

---

## STEP 8 — Set secrets

Generate strong random secrets and push them to each Worker. The same `UNSUB_TOKEN_PEPPER` must be set on both `sender` and the root web worker so tokens minted by one verify by the other.

```sh
PEPPER=$(openssl rand -hex 32)
JWT=$(openssl rand -hex 32)

# Web worker (root)
echo "$PEPPER" | wrangler secret put UNSUB_TOKEN_PEPPER
echo "$JWT"    | wrangler secret put ADMIN_API_JWT_SECRET

# Sender worker
echo "$PEPPER" | wrangler secret put UNSUB_TOKEN_PEPPER \
  --config workers/sender/wrangler.generated.toml
```

**Success criterion:** `wrangler secret list` (and the same with `--config workers/sender/wrangler.generated.toml`) shows the secret names. Don't echo the values back to the human — they should not appear in any chat transcript.

---

## STEP 9 — Run database migrations

Migration SQL files live at `packages/db/migrations/`. Apply each one in lexical order against the D1 database you created in STEP 4. The database name is `bulletinmail-<APEX-without-dots>`.

```sh
for f in packages/db/migrations/*.sql; do
  echo "applying $f"
  wrangler d1 execute bulletinmail-<APEX-without-dots> --remote --file "$f" \
    || { echo "FAILED on $f"; exit 1; }
done
```

If a later migration fails because an earlier one half-applied, **do not auto-rollback** — ask the human. D1 rollback is destructive.

**Success criterion:** every migration applies cleanly. Verify by running:

```sh
wrangler d1 execute bulletinmail-<APEX-without-dots> --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

You should see at least: `admins`, `groups`, `magic_links`, `members`, `messages`, `tenants`, `deliveries`. (Wiki content lives in a Durable Object, not D1, so don't expect a `wiki_pages` table.)

---

## STEP 10 — Build + deploy

```sh
pnpm build:web:single
pnpm deploy:single
```

These two commands build the admin SPA (no Astro docs site — `singleTenant: true` skips that) and deploy the bundled web Worker, then:

```sh
pnpm deploy:inbound
pnpm deploy:sender
```

deploys the two mail Workers.

**Success criterion:** all three `wrangler deploy` runs print a version ID and the deployed routes. The web Worker should print a wildcard route covering `<APEX>` and `*.<APEX>`.

---

## STEP 11 — Wire Email Routing → inbound Worker

The inbound Worker now exists, so the human's Email Routing catch-all can target it. Ask the human:

> Go to **Email → Email Routing → Routing rules** in the Cloudflare dashboard for `<APEX>`. Edit the **catch-all** rule. Set **Action: Send to a Worker** and pick `bulletinmail-inbound` (or whatever the inbound Worker is named — check `workers/inbound/wrangler.generated.toml`). Save.

**Success criterion:** the human confirms the rule is saved.

---

## STEP 12 — Smoke test

Verify the apex serves the wiki home:

```sh
curl -sI https://<APEX>/ | head -1
# expect: HTTP/2 200
```

Verify the signup gate is open (bootstrap hasn't happened yet):

```sh
curl -s https://<APEX>/api/auth/signup-available
# expect: {"available":true}
```

Bootstrap the first admin. Ask the human for the email they want to use:

```sh
curl -s -X POST https://<APEX>/api/auth/signup \
  -H "Content-Type: application/json" \
  --data '{"email":"<HUMAN_ADMIN_EMAIL>"}'
# expect: 204 (empty body)
```

Tell the human:

> Check your inbox for an email from `noreply@mail.<APEX>` with subject starting "Sign in to <PRODUCT_NAME>." Click the link. You should land at `https://<APEX>/admin/` and see the admin home.

Verify the gate is now closed:

```sh
curl -s https://<APEX>/api/auth/signup-available
# expect: {"available":false}
```

Send a mail-tester probe — ask the human to:

> From the admin SPA, create your first list group (e.g. `announcements`), add yourself as a member, then send any external email to `announcements@mail.<APEX>`. It should arrive back within seconds.

For a deliverability check, the human can send one bulletin to a fresh address at https://www.mail-tester.com — the goal is **10/10** before opening the list to subscribers.

**Success criterion:** all four `curl` checks pass. The human confirms they received and signed in via the magic-link email. The first outbound bulletin lands in their inbox.

---

## STEP 13 — Hand off

Print a final summary for the human:

```
Deployment complete:

  Apex:           https://<APEX>/
  Admin:          https://<APEX>/admin/
  Mail host:      mail.<APEX>
  Signup gate:    closed (1 admin exists)

Resources created in Cloudflare:
  D1 database:    bulletinmail-<APEX-without-dots>
  R2 bucket:      bulletinmail-<APEX-without-dots>-attachments
  Queues:         bulletinmail-<APEX-without-dots>-send, ...-send-dlq
  KV:             bulletinmail-<APEX-without-dots>-cache

Files in your repo:
  deployments/<APEX>/instance.config.json     — your overlay (commit this)
  deployments/<APEX>/cloudflare-resources.json — your resource IDs (commit this)
  wrangler.generated.toml                      — generated, gitignored
  workers/*/wrangler.generated.toml            — generated, gitignored

To deploy again later:
  pnpm render-wrangler --instance <APEX>
  pnpm build:web:single && pnpm deploy:single
  pnpm deploy:inbound && pnpm deploy:sender

For ongoing operations see docs/how-to/operations.md.

You are now the operator of this instance. Read docs/how-to/self-host.md §15
for the legal/operator obligations you've taken on.
```

---

## When to stop and ask

The LLM should stop and hand control back to the human in these cases:

- **`wrangler login` needed** — OAuth flow can't be automated.
- **DNS records require dashboard work** — if the API token doesn't have Zone:DNS:Edit, ask the human to add records manually.
- **Email Routing enable / Email Sending enable** — dashboard-only.
- **Any `wrangler deploy` fails with a permission error** — usually means the user doesn't have Workers:Edit on this account; ask, don't retry.
- **Resource name collision in STEP 4** — never auto-rename or auto-delete; ask first.
- **The human's domain isn't a Cloudflare zone** — they need to add the zone themselves in the dashboard.

## Failure modes the agent should recognize

| Symptom | Likely cause | Recovery |
|---|---|---|
| `wrangler d1 create` says "exceeded limit" | Free plan limit on D1 databases | Tell the human they need Workers Paid, or delete an unused DB |
| `pnpm deploy:single` says "Account ID required" | `account_id` missing in `cloudflare-resources.json` | Fill it in from STEP 0 and re-render |
| `curl https://<APEX>/` returns Cloudflare 1014 (CNAME cross-user) | Apex `A` record is wrong | Re-check STEP 5 — it must be a proxied A record on the user's account |
| `curl https://<APEX>/api/auth/signup-available` returns 404 | Worker not deployed, or wildcard route not bound | Re-check STEP 10 output for the route binding |
| Magic-link email never arrives | Email Sending not enabled, or DKIM not provisioned | Re-check STEP 6; `dig TXT default._domainkey.mail.<APEX>` should return a long key |
| `tail` shows `INSTANCE_FEATURE_SINGLE_TENANT undefined` | Stale `wrangler.generated.toml` | Re-run `pnpm render-wrangler --instance <APEX>` and redeploy |

---

## What this guide does not cover

- **Multi-tenant deployments** (one Cloudflare account, many orgs on `<slug>.<apex>` subdomains) — read [`self-host.md`](/how-to/self-host/) and skip the `mailSubdomain` + `features.singleTenant` parts.
- **BYO-domain tenants** — V4 feature; not needed for single-tenant.
- **Custom SMTP providers (Resend, SES)** — the sender Worker has a single `env.EMAIL.send` call you can swap; out of scope for first-deploy.
- **Multi-region or Durable-Object placement tuning** — Cloudflare defaults work fine until you have real load.

---

## Why these design choices

Two single-tenant choices made by this guide matter for the agent to defend if the human pushes back:

**Why `mail.<APEX>` instead of just the apex?** Two reasons. (1) Web traffic and mail traffic have different SPF/DMARC requirements — putting them on different DNS labels keeps each policy clean. (2) If the org ever runs another email service (Google Workspace, Microsoft 365) on the apex, BulletinMail's mail records on `mail.<APEX>` don't conflict.

**Why default the tenant slug to "mail"?** In single-tenant mode the slug is invisible to anyone outside the operator — it never appears in a URL or an email address. Tying it to `mailSubdomain` makes the underlying DNS label and the database slug the same string, which means one fewer thing for the operator to remember. If the operator overrides `mailSubdomain` to `"lists"`, the slug becomes `"lists"` automatically.

If the human wants the apex itself to handle mail (no subdomain), they can set `"mailSubdomain": null` in the overlay — but then the slug defaults to `"mail"` and they should pick something else manually. That's an advanced path the agent should flag and ask about; it's not the recommended default.
