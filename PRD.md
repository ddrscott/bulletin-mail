# PRD — BulletinMail

A multi-tenant mailing list service for churches and small organizations, built entirely on Cloudflare's developer platform.

> **Product name:** BulletinMail (informally "Bulletin"). **Apex domain (reference instance):** `bulletinmail.org`. Tenants get a subdomain of the apex (e.g. `firstpresby.bulletinmail.org`); the marketing site lives at the apex and the admin app at `app.bulletinmail.org`.
>
> **Distribution:** The codebase is open source under **AGPL-3.0**. `bulletinmail.org` is the reference deployment operated by the project maintainer; any organization can self-host its own instance under its own apex domain. Every per-instance value (apex domain, product name, support addresses, reserved-slug additions, archive URL template) is centralized in a single `InstanceConfig` schema. See §19 (Distribution Model) and §20 (Instance Configuration Manifest).

---

## 1. Vision

Mailing lists that just work. A volunteer church administrator can create a list in 60 seconds at `groupname@orgslug.bulletinmail.org`, paste in members, and the next email a pastor sends reaches every member with proper threading in Gmail and Apple Mail. No DNS to configure. No per-seat pricing. No spam-folder hell.

The architectural bet is that **owning the parent domain** (and serving every customer from a subdomain of it) eliminates the two hardest parts of running a listserv: DMARC alignment and IP reputation. Cloudflare's Email Routing + Email Sending stack handles the rest.

---

## 2. Goals & Non-Goals

### Goals (V1)
- Multi-tenant SaaS on Cloudflare's stack (Workers, D1, R2, Queues, Email Routing, Email Sending)
- Zero DNS configuration for the default tier (shared `bulletinmail.org`)
- Correct email standards compliance: DMARC alignment, RFC 5322 threading, RFC 8058 one-click unsubscribe, RFC 2369 List-* headers
- Privacy-first defaults: archives are members-only unless explicitly opted out
- Sustainable free tier for small churches; bring-your-own-domain as the paid tier hook
- Reliable delivery to Gmail, Apple Mail, Outlook, Yahoo

### Non-Goals (V1)
- Email marketing / one-way newsletter blasts (this is two-way discussion + announcements)
- Mobile native apps
- SSO / federated identity
- Discourse-style forum UI (just email + a simple threaded web archive)
- Google Groups migration tooling (V2)
- Public signup landing page (V2 — onboard manually until product-market fit)

### Explicit Anti-Goals
- We are **not** an email marketing platform. No A/B testing, no analytics dashboards for opens/clicks, no merge tags. If someone asks for those features, the answer is "use Mailchimp."

---

## 3. Users & Use Cases

**Primary user:** small-church administrator. Volunteer, non-technical, manages one or two lists.
**Secondary user:** pastor or staff member sending announcements.
**Tertiary user:** member receiving and occasionally replying.

### Use cases
- **Announce-only.** Pastor → congregation. Members can't post. Replies go privately to the pastor, not the list.
- **Prayer chain.** Any member can post. Sensitive content — archive must be private.
- **Committee discussion.** Small group (5–25 people) having threaded back-and-forth.
- **Volunteer coordination.** Open posting, light moderation, archived.

### Scale targets (V1)
- 100 tenants
- 5 groups per tenant on average
- 50 members per group on average
- 4 messages per group per week
- ≈ 500k outbound emails / month

These numbers should fit comfortably inside Cloudflare's free / low-tier pricing.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Cloudflare zone: bulletinmail.org                             │
│  - MX: bulletinmail.org   → Email Routing  (system addresses)  │
│  - MX: *.bulletinmail.org → Email Routing  (tenant lists)      │
│  - SPF, DKIM, DMARC on the parent domain                       │
│  - Marketing site at apex; admin app at app.bulletinmail.org   │
└────────────────────────────────────────────────────────────────┘
                            │
                            │ inbound mail
                            ▼
              ┌─────────────────────────────┐
              │  Cloudflare Email Routing   │
              │  catch-all → inbound worker │
              └──────────────┬──────────────┘
                             ▼
              ┌─────────────────────────────┐
              │   inbound-worker            │
              │   • parse MIME              │
              │   • resolve (tenant,group)  │
              │   • validate sender         │
              │   • store msg + attach (R2) │
              │   • enqueue per-recipient   │
              └──────────────┬──────────────┘
                             ▼
              ┌─────────────────────────────┐
              │   Cloudflare Queue          │
              │   (one job per recipient)   │
              └──────────────┬──────────────┘
                             ▼
              ┌─────────────────────────────┐
              │   sender-worker             │
              │   • build outbound MIME     │
              │   • rewrite From            │
              │   • set threading headers   │
              │   • set List-* headers      │
              │   • send (Email binding)    │
              │   • record delivery         │
              └─────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  web-worker                                                    │
│  (single HTTP entry — wildcard route `*<apex>/*`               │
│   handles apex, app subdomain, and every tenant subdomain;     │
│   host-based dispatch inside the handler, à la relaytty.com)   │
│                                                                │
│  Apex routes:                                                  │
│    GET  /                       marketing landing              │
│    GET  /u/:token               unsubscribe confirmation HTML  │
│    POST /u/:token               one-click unsubscribe (RFC 8058)│
│    GET  /g/:tenant/:group       archive viewer (Phase 2)       │
│    POST /api/bounce-events      Email Service event webhook    │
│                                                                │
│  Admin subdomain (app.<apex>): admin app + admin-api (Phase 2) │
│  Tenant subdomain (<slug>.<apex>): per-tenant archive (Phase 2)│
│                                                                │
│  The mailto: form of unsubscribe (unsubscribe+{token}@<apex>)  │
│  is handled by the inbound-worker via a special recipient      │
│  pattern check before normal group resolution.                 │
└────────────────────────────────────────────────────────────────┘

D1 tables: tenants, groups, members, messages, attachments,
           deliveries, moderation_queue, admins, magic_links,
           unsub_tokens

R2 prefix: attachments/{message_id}/{filename}
```

---

## 5. Tech Stack

| Layer            | Choice                                                 |
| ---------------- | ------------------------------------------------------ |
| Runtime          | Cloudflare Workers (TypeScript, modules format)        |
| Inbound mail     | Cloudflare Email Routing (catch-all rules)             |
| Outbound mail    | Cloudflare Email Sending binding                       |
| Database         | Cloudflare D1                                          |
| Object storage   | Cloudflare R2                                          |
| Async fan-out    | Cloudflare Queues                                      |
| MIME parsing     | `postal-mime`                                          |
| MIME building    | hand-rolled in `packages/mime` (small surface)         |
| ID generation    | ulid (`ulidx`)                                         |
| Admin UI         | Cloudflare Pages, plain HTML + TS, no framework        |
| Auth             | Magic links only — no passwords, ever                  |
| Local dev        | `wrangler dev` + Miniflare                             |
| Package manager  | pnpm workspaces                                        |
| Tests            | `vitest` for unit, `wrangler dev` + scripts for e2e    |

**Hard rule:** no dependency that doesn't run cleanly on Workers. No Node-only APIs, no native modules. If something must run elsewhere (e.g. a one-off bulk import), it goes in a CLI in `cli/`, not in a Worker.

---

## 6. Domain Strategy

**Decision: subdomain-per-tenant.**

Every tenant gets `<tenant-slug>.bulletinmail.org`. List addresses are `<list-name>@<tenant-slug>.bulletinmail.org`.

Examples:
- `announcements@firstpresby.bulletinmail.org`
- `prayer@firstpresby.bulletinmail.org`
- `youth@stmarks.bulletinmail.org`

### DNS setup (one-time, on `bulletinmail.org`)
- `bulletinmail.org` MX records → Cloudflare Email Routing (for system addresses: `hello@`, `support@`, `abuse@`, `dmarc@`, `unsubscribe+token@`)
- `*.bulletinmail.org` MX records → Cloudflare Email Routing (for tenant list mail)
- `bulletinmail.org` and `*.bulletinmail.org` proxied A/AAAA (or CNAME flattening) so the wildcard Worker route can intercept HTTP for both apex and every tenant subdomain — see §6.5
- SPF, DKIM, DMARC on the parent domain (applies to subdomains via DMARC `sp=` and standard subdomain inheritance)

### 6.5 HTTP routing (apex + wildcard subdomain → one Worker)

A single `web-worker` handles every HTTP request — for the apex (`bulletinmail.org`), the admin app (`app.bulletinmail.org`), and every tenant subdomain (`<tenant>.bulletinmail.org`). The pattern mirrors [relaytty.com](https://relaytty.com): one Worker, one wildcard route, host-based dispatch inside the handler. Rationale:

1. **Operator setup stays trivial.** A single `routes = [{ pattern = "*<apex>/*", zone_name = "<apex>" }]` declaration covers the apex AND every present-and-future tenant subdomain — no per-tenant route to add on signup.
2. **Tenant subdomains "just work" over HTTP.** A browser hitting `https://firstpresby.bulletinmail.org/g/announcements` reaches our code without any per-tenant DNS or routing change.
3. **One coherent codebase** for everything HTTP — unsubscribe, archive, admin API, marketing copy — so cross-cutting concerns (auth, CSP, rate limits, error pages) live in one place.

Dispatch contract (see `packages/shared/src/host.ts → classifyHost`):

| Host                            | `kind`     | Handled by                  |
| ------------------------------- | ---------- | --------------------------- |
| `bulletinmail.org`              | `apex`     | landing, /u/:token, /g/..., /api/bounce-events |
| `app.bulletinmail.org`          | `admin`    | admin app + admin-api (Phase 2) |
| `<slug>.bulletinmail.org`       | `tenant`   | per-tenant archive (Phase 2; today: redirect to apex archive) |
| anything else                   | `unknown`  | 404                         |

**Apex-only routes MUST guard their host.** A path like `/g/:tenant/:group` defined on the apex would otherwise silently intercept the equivalent path on a tenant subdomain. The relaytty playbook applies here too: `if (classifyHost(...).kind !== "apex") return next();` at the top of every apex-only handler. See `workers/web/src/routes/*.ts` for the pattern.

### Reserved subdomains

Tenant slugs are real DNS subdomains, so the signup flow must reject any slug that would collide with system or future-use subdomains. The effective reserved set is the union of a generic base list (lives in `packages/shared/src/slug.ts`, applies to every self-hosted instance) and per-instance additions (`additionalReservedSlugs` in the operator's `instance.config.json`). Generic base list (enforce in code from day one; expand as needed):

```
www, app, api, admin, mail, smtp, imap, pop, mx,
support, help, hello, abuse, dmarc, postmaster, noreply,
status, blog, docs, dev, staging, test, demo,
about, billing, pay, account, accounts, auth, login,
public, private, system, root, cloudflare,
ml, list, lists, group, groups, bulletin, bulletins
```

Plus: no slug shorter than 3 characters, no leading/trailing hyphens, lowercase ASCII letters/digits/hyphens only, must match `/^[a-z][a-z0-9-]{2,}[a-z0-9]$/`.

### Rejected alternative: slug-prefix
`firstpresby-prayer@bulletinmail.org`. Simpler MX, but uglier and locks in a naming convention that can't gracefully evolve.

### Open Phase-0 verification
Confirm Cloudflare Email Routing supports wildcard subdomain routing under a single zone, with a single catch-all rule that fires for `*@*.bulletinmail.org`. If not, fall back to slug-prefix and reassess for V2. **This must be verified before any code is written.**

### BYO domain (paid tier)
Customer points an MX record from their domain at our Email Routing target. We add a route mapping their domain to their tenant in D1. Outbound DKIM-signs from their domain (per-domain key managed via Cloudflare API). Sender worker chooses signing domain based on tenant.

---

## 7. Data Model (D1)

> All timestamps are integer Unix milliseconds. All ids are 26-char ulids unless noted.

```sql
-- Tenants (churches / organizations)
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,                -- e.g. 'firstpresby'
  display_name  TEXT NOT NULL,
  byo_domain    TEXT UNIQUE,                         -- nullable; e.g. 'firstpresby.org'
  plan          TEXT NOT NULL DEFAULT 'free',        -- 'free' | 'byo_domain'
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'       -- 'active' | 'suspended'
);
CREATE INDEX idx_tenants_byo_domain ON tenants(byo_domain) WHERE byo_domain IS NOT NULL;

-- Groups (lists)
CREATE TABLE groups (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,                 -- local-part, e.g. 'announcements'
  display_name        TEXT NOT NULL,
  description         TEXT,
  posting_policy      TEXT NOT NULL,                 -- 'members' | 'moderated' | 'announce_only' | 'open'
  reply_to_policy     TEXT NOT NULL DEFAULT 'list',  -- 'list' | 'sender'
  subject_prefix      TEXT,                          -- e.g. '[Announcements]'
  archive_visibility  TEXT NOT NULL DEFAULT 'members', -- 'members' | 'public' | 'none'
  max_message_size    INTEGER NOT NULL DEFAULT 10485760, -- 10 MB
  created_at          INTEGER NOT NULL,
  UNIQUE(tenant_id, name)
);

-- Members (subscribers)
CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'member',    -- 'member' | 'moderator' | 'sender_only'
  delivery_mode   TEXT NOT NULL DEFAULT 'each',      -- 'each' | 'digest' | 'paused'
  status          TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'bouncing' | 'unsubscribed'
  bounce_count    INTEGER NOT NULL DEFAULT 0,
  last_bounce_at  INTEGER,
  joined_at       INTEGER NOT NULL,
  UNIQUE(group_id, email)
);
CREATE INDEX idx_members_email ON members(email);
CREATE INDEX idx_members_group_status ON members(group_id, status);

-- Messages (one per list send)
CREATE TABLE messages (
  id                    TEXT PRIMARY KEY,            -- our outbound Message-ID local part
  group_id              TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  original_message_id   TEXT,                        -- sender's original RFC 5322 Message-ID
  in_reply_to_outbound  TEXT,                        -- our prior outbound Message-ID (parent)
  thread_id             TEXT NOT NULL,               -- first message id in the thread
  from_email            TEXT NOT NULL,
  from_name             TEXT,
  subject               TEXT NOT NULL,
  body_text             TEXT,
  body_html             TEXT,
  has_attachments       INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL,               -- 'received' | 'queued' | 'sending' | 'sent' | 'rejected' | 'held_moderation'
  rejection_reason      TEXT,
  received_at           INTEGER NOT NULL,
  sent_at               INTEGER
);
CREATE INDEX idx_messages_group_received ON messages(group_id, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX idx_messages_orig_mid ON messages(original_message_id);

-- Attachments
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  content_id    TEXT                                 -- for inline images (cid:)
);

-- Deliveries (per-recipient send result)
CREATE TABLE deliveries (
  id                   TEXT PRIMARY KEY,
  message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id            TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status               TEXT NOT NULL,                -- 'queued' | 'sent' | 'bounced' | 'failed' | 'suppressed'
  provider_message_id  TEXT,
  error                TEXT,
  attempted_at         INTEGER,
  delivered_at         INTEGER,
  UNIQUE(message_id, member_id)
);
CREATE INDEX idx_deliveries_message ON deliveries(message_id);
CREATE INDEX idx_deliveries_provider ON deliveries(provider_message_id);

-- Moderation queue
CREATE TABLE moderation_queue (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,                        -- 'pending' | 'approved' | 'rejected'
  decided_by   TEXT,                                 -- admin_id
  decided_at   INTEGER,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_mod_queue_pending ON moderation_queue(group_id, state, created_at);

-- Tenant admins
CREATE TABLE admins (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',          -- 'admin' | 'super_admin'
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, email)
);

-- Magic links (passwordless auth)
CREATE TABLE magic_links (
  token       TEXT PRIMARY KEY,                      -- random 32-byte hex
  admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- One-click unsubscribe tokens (one per member, opaque)
CREATE TABLE unsub_tokens (
  token       TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- Audit log (lightweight; for debugging and abuse)
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  actor       TEXT,                                  -- 'system' | 'admin:<id>' | 'sender:<email>'
  action      TEXT NOT NULL,
  details     TEXT,                                  -- JSON
  created_at  INTEGER NOT NULL
);
```

---

## 8. Email Pipeline

### 8.1 Inbound Worker

**Entry point:** `email(message, env, ctx)` handler bound to Email Routing.

**Algorithm:**

```
1. Recipient = message.to (single recipient per delivery event)
2. Parse recipient → (local_part, domain)
3. Resolve (tenant, group):
     - If domain ends with '.bulletinmail.org':
         tenant_slug = first label of domain
         lookup tenants.slug = tenant_slug
         lookup groups.name = local_part WHERE tenant_id = tenant.id
     - Else: lookup tenants.byo_domain = domain, then group
     - On miss: reject with SMTP 5.1.1 "no such list"
4. Parse MIME body with postal-mime
5. Validate sender per group.posting_policy:
     - 'members':         sender email must be active member
     - 'open':            no validation (rate-limited)
     - 'moderated':       route to moderation_queue, no further send
     - 'announce_only':   sender must be member with role IN ('moderator', 'sender_only')
   On rejection: send bounce / reply to sender explaining why
6. Reject oversize messages (> group.max_message_size). Replace large attachments
   with R2 download links inline if > 5 MB.
7. Strip dangerous attachments: .exe .bat .scr .js .vbs .com .pif .cmd .jar
   Log to audit_log.
8. Generate outbound Message-ID: `<{ulid}@{tenant_slug}.bulletinmail.org>`
9. Resolve threading parent (see §9.2)
10. INSERT messages row, attachments rows, copy bytes to R2
11. For each active member of the group:
      INSERT deliveries(status='queued')
      ENQUEUE send job {message_id, member_id}
```

**Time budget:** inbound worker must finish in < 5s of CPU. Keep MIME parsing efficient; offload anything heavy to the queue consumer.

### 8.2 Sender Worker (Queue Consumer)

```
For each batch from SEND_QUEUE:
  For each job {message_id, member_id}:
    1. Load message + member from D1 (single query w/ join if possible)
    2. Skip if member.status != 'active' → mark delivery 'suppressed'
    3. Load attachments from R2
    4. Build outbound MIME (see §9.1 for header rules)
    5. Send via env.EMAIL.send(...)
    6. UPDATE deliveries SET status='sent', provider_message_id, delivered_at
    7. On send error: status='failed', error=<text>, retry per Queue policy
```

**Concurrency:** Cloudflare Queue settings — batch size 10, max concurrency 10. Tune based on Email Sending rate limits.

### 8.3 Bounce events (route in the web worker)

Consumes Email Service delivery events. Delivery mechanism TBD — verify in Phase 0 whether this is a webhook, Worker binding, or polled API. The web worker exposes `POST /api/bounce-events` for the webhook case; if Cloudflare ends up using a binding instead, the route is unused and a separate consumer file in the same worker handles the events.

```
On event:
  Match by provider_message_id → deliveries row
  status='bounced' or 'failed'
  Update member:
    bounce_count += 1
    last_bounce_at = now
    If permanent (5.x.x):           status='bouncing'
    Else if bounce_count >= 5 in 30 days: status='bouncing'
  If member.status changed to 'bouncing':
    audit_log entry
    Send admin notification (rate-limited — one per tenant per day max)
```

### 8.4 Unsubscribe (HTTP routes in the web worker)

Two pathways, both must succeed in < 1 second per RFC 8058:

**HTTP:** `https://bulletinmail.org/u/:token` — routes in `workers/web/src/routes/unsub.ts`.
- `GET`: render minimal HTML confirmation page (defense against accidental prefetch by anti-spam bots)
- `POST` with body `List-Unsubscribe=One-Click`: immediate unsubscribe, no confirmation, return 200

**Mailto:** `unsubscribe+{token}@bulletinmail.org`
- Handled by inbound worker via a special recipient pattern check before normal group resolution
- Any body, any subject — token is enough

Action:
- Lookup token → member
- UPDATE members SET status='unsubscribed'
- audit_log entry
- Token remains valid (idempotent)

---

## 9. Email Standards Compliance (Non-Negotiable)

### 9.1 DMARC Alignment via From Rewrite

**The core architectural decision.** Every outbound message has:

```
From: "{sender_name} via {group_display_name}" <{tenant_slug}-{group_local}@bulletinmail.org>
```

Note the slug is in the From local-part with a `-` separator, not as a subdomain. This is forced by Cloudflare Email Service's sender-domain authorization (§17 #6) — only the apex is authorized for outbound. The From domain is therefore always the apex (or a BYO-domain tenant's domain), which we DKIM-sign. SPF passes via Cloudflare's authorized IPs. DMARC aligns.

`Reply-To` keeps the subdomain shape because inbound (Email Routing catch-all) handles it cleanly. Set per group.reply_to_policy:
- `'list'` → `<{group_local}@{tenant_slug}.bulletinmail.org>` (replies come back through us via the subdomain catch-all)
- `'sender'` → original sender's address (replies bypass the list, e.g. for announce-only)

The original sender's email is preserved in `X-Original-From` for archive/debug purposes.

**Hard rule:** no code path may set `From` to anything outside a domain we sign for. Add a runtime assertion at the bottom of the MIME builder.

### 9.2 Threading

Threading must work correctly in Gmail web, Apple Mail, Outlook desktop, Outlook web, and Thunderbird. **Phase 1 acceptance requires manual verification in all five.**

**Headers we emit on every outbound message:**

```
Message-ID: <{message.id}@{tenant_slug}.bulletinmail.org>
```

For a **new** thread:
- No `In-Reply-To`
- No `References`

For a **reply** to an existing message:
- `In-Reply-To: <{parent.id}@{tenant_slug}.bulletinmail.org>`
- `References: ` (full chain, see below)

**Parent resolution (in inbound worker):**

```
parent = null
if (incoming has In-Reply-To header):
  candidates = [In-Reply-To] + (References header split into ids)
  for each candidate id (most recent first):
    parent = SELECT * FROM messages WHERE
      original_message_id = candidate
      OR id = strip_local_part(candidate)
    if found: break
```

**References chain build:**

```
if parent is null:
  references = []
  thread_id = new_message.id
else:
  references = parent.references_array + [parent_outbound_message_id]
  thread_id = parent.thread_id
```

Cap References at 20 entries (RFC 5322 implementations vary; this is safe).

### 9.3 Subject Prefix Handling

If `group.subject_prefix` is set, the outbound subject is computed as:

```
1. Strip all existing instances of the prefix (case-insensitive) from subject
2. Normalize Re:/RE:/Re[N]: to a single 'Re: ' if present anywhere
3. Reassemble: '{prefix} {Re: }{cleaned subject}'
```

Examples (`prefix = '[Announcements]'`):
| Incoming                                        | Outgoing                              |
| ----------------------------------------------- | ------------------------------------- |
| `Service tomorrow`                              | `[Announcements] Service tomorrow`    |
| `Re: [Announcements] Service tomorrow`          | `[Announcements] Re: Service tomorrow`|
| `Re: [Announcements] Re: [Announcements] Foo`   | `[Announcements] Re: Foo`             |
| `Fwd: [Announcements] Foo`                      | `[Announcements] Fwd: Foo`            |

### 9.4 List-* Headers (RFC 2369 + RFC 8058)

Every outbound message:

```
List-Id: <{group_local}.{tenant_slug}.bulletinmail.org>
List-Post: <mailto:{group_local}@{tenant_slug}.bulletinmail.org>
List-Archive: <https://bulletinmail.org/g/{tenant_slug}/{group_local}>
List-Unsubscribe: <mailto:unsubscribe+{token}@bulletinmail.org>, <https://bulletinmail.org/u/{token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
Precedence: list
Auto-Submitted: auto-generated
```

The `<mailto:>` form must come **first** in `List-Unsubscribe` — some clients use only the first.

### 9.5 DNS Records

On `bulletinmail.org`:

```
bulletinmail.org.              MX    10 <cloudflare email routing target>
*.bulletinmail.org.            MX    10 <cloudflare email routing target>
bulletinmail.org.              TXT   "v=spf1 include:_spf.mx.cloudflare.net ~all"
*._domainkey.bulletinmail.org  TXT   (managed by Cloudflare Email Sending)
_dmarc.bulletinmail.org        TXT   "v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@bulletinmail.org; ruf=mailto:dmarc@bulletinmail.org; pct=100; adkim=r; aspf=r"
```

For BYO domain tenants, the same set scoped to their domain (we provide a one-click DNS instructions page or, if their domain is on Cloudflare, automate via API).

---

## 10. Admin Surface

Single web app served at the `app.bulletinmail.org` host by `workers/web` (host-routed inside the same Worker that serves the apex landing and `/u/:token`; see §6.5). Marketing copy at the apex `bulletinmail.org` is rendered by the same Worker.

### V1 (Phase 2) screens

1. **Sign-in.** Email input → magic link. No tenant selection on sign-in; magic link is scoped to one admin id.
2. **Tenant home.** List of groups. Quick stats per group: member count, messages this week.
3. **Group detail.** Tabs: Members, Settings, Recent Messages, Moderation Queue.
4. **Members tab.** Searchable table. Add (single email, or paste CSV). Remove. Change role. View bounce status. Bulk import preview.
5. **Settings tab.** Posting policy, reply-to policy, subject prefix, archive visibility, max message size.
6. **Recent Messages tab.** Last 50, with delivery summary (X sent / Y bounced).
7. **Moderation queue.** Pending messages with sender, subject, preview. Approve / Reject inline. Email-based moderation (reply 'approve' to a moderation notification) is V2.
8. **Sign-up.** Manual only for V1 — sysop creates tenant + first admin via CLI, sends magic link.

### V2 archive

Per-group threaded archive at `bulletinmail.org/g/:tenant/:group`:
- Member-auth required unless `archive_visibility = 'public'`
- Threaded view, newest-first
- Full-text search via D1 FTS5
- Email addresses obfuscated in HTML
- Per-thread permalink

### Public archive opt-in (V2)
Changing `archive_visibility` from `'members'` to `'public'` requires an explicit click-through confirmation that warns about privacy implications. **Default is and remains `'members'`.**

---

## 11. Phased Implementation Plan

### Phase 0 — Foundation (1–2 days)

**Verify before writing code:**
- [ ] Cloudflare Email Routing supports `*@*.bulletinmail.org` catch-all via one rule (or document the alternative)
- [ ] Email Sending public-beta pricing and rate limits documented and acceptable for our scale targets
- [ ] Bounce / delivery event delivery mechanism understood (webhook vs binding vs polled)

**Then:**
- [ ] Cloudflare zone setup for `bulletinmail.org`
- [ ] DNS: MX, SPF, DKIM, DMARC (see §9.5)
- [ ] `wrangler.toml` workspace skeleton, all bindings declared
- [ ] D1 database created, migrations run
- [ ] R2 bucket created
- [ ] Queue created
- [ ] Empty CI: deploys to staging on push to `main`

### Phase 1 — Core Pipeline (5 days) — MVP

- [ ] `packages/mime`: parse, build, threading, subject helpers (unit tested)
- [ ] `packages/db`: typed query helpers (`getTenantBySlug`, `getGroupByLocalpart`, etc.)
- [ ] `packages/shared`: reserved-subdomain list + slug validator (see §6)
- [ ] `workers/inbound`: parse → resolve → validate → store → enqueue (+ mailto unsubscribe pattern)
- [ ] `workers/sender`: dequeue → build MIME → send → record
- [ ] `workers/web`: single HTTP entry — host-based dispatch (apex / app / `<tenant>`), routes for `/u/:token`, `/api/bounce-events`, apex landing
- [ ] `cli/`: `create-tenant`, `create-group`, `add-member`, `remove-member`, `list-groups`
- [ ] Mail-tester.com test: 10/10 score required

**Phase 1 acceptance:**
1. Create tenant + group + 10 members via CLI
2. Send from external Gmail → list → all 10 receive
3. Reply from one member → goes back through list → 9 receive correctly threaded
4. Verify threading correct in Gmail web, Apple Mail, Outlook desktop, Outlook web, Thunderbird
5. Click "unsubscribe" link in Gmail's UI → unsubscribed in < 1 second, confirmed in D1
6. Send 20 messages to a fake bouncing address → member auto-disabled after 5
7. mail-tester.com score = 10/10
8. DMARC report (run for 7 days) shows 100% pass

### Phase 2 — Admin UI (7 days)

- [ ] `apps/admin` Pages app (plain TS, no framework) — served from `workers/web` under the `app.<apex>` host
- [ ] Admin API routes in `workers/web/src/routes/admin/*`: magic-link auth, session cookies (HttpOnly, Secure, SameSite=Lax)
- [ ] Tenant home, group detail, members tab, settings tab, moderation queue
- [ ] CSV paste import with preview/dry-run

### Phase 3 — Archive (7 days)

- [ ] D1 FTS5 index on messages
- [ ] Threaded archive view
- [ ] Member-auth flow (magic link to member, separate from admin auth)
- [ ] Public archive opt-in flow

### Phase 4 — BYO Domain (5 days)

- [ ] Self-service domain add (verification via TXT or DNS-on-Cloudflare API)
- [ ] Per-domain DKIM key management
- [ ] Sender worker chooses signing domain per tenant
- [ ] Stripe integration for paid tier

### Deferred (V2+)

- Digest delivery mode
- Google Groups import
- Mobile-friendly PWA
- Public API
- Multi-admin per tenant with RBAC
- Email-based moderation actions ("reply 'approve'")

---

## 12. Cross-Phase Invariants

These are enforced by code, not just intent:

1. **No outbound message has a `From` domain we don't DKIM-sign for.** Add an assertion at the bottom of the MIME builder.
2. **No outbound message ships without a `List-Unsubscribe` header.** Same place, same assertion.
3. **No member receives the same message twice.** `UNIQUE(message_id, member_id)` in `deliveries` is the backstop.
4. **No `held_moderation` message is auto-sent.** Type-check the status at the top of the sender worker.
5. **No public archive without explicit `archive_visibility = 'public'` set in D1.** Default is `'members'`; admin UI requires confirmation modal to change.
6. **No passwords stored.** Don't even create a column for hashed passwords. Magic links only.

---

## 13. Known Risks & Mitigations

| Risk                                                        | Likelihood | Mitigation                                                                                          |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Cloudflare Email Sending beta pricing balloons              | Medium     | Abstract sender behind an interface; have a Resend or SES fallback ready to swap in                 |
| Email Routing wildcard subdomain doesn't work as expected   | Medium     | Falls back to slug-prefix model — uglier but functional. Verify in Phase 0 before any code          |
| Email Routing 25 MB inbound size limit                      | High       | Detect oversize early; replace large attachments with R2 download links in outbound body            |
| One spammy tenant ruins shared domain reputation            | Medium-High| Per-tenant rate limits (default 1000 msgs/day); manual review for new tenants' first 30 days; abuse@ inbox monitored |
| Threading breaks in Outlook                                 | High       | Outlook is in Phase 1 acceptance criteria. Test in real Outlook, not just Outlook web               |
| Privacy leak via archive misconfig                          | High       | Default `'members'`; explicit opt-in to public with confirmation modal; obfuscate emails in HTML    |
| Bounce-loop (unsubscribe email bounces)                     | Low        | Suppress sends to non-active members; unsubscribe is a status change, not an email                  |
| Compromised member account spams the list                   | Medium     | Rate limit per sender, content scanning, admin alert on volume anomalies                            |
| Members sharing their unsubscribe URL by accident           | Medium     | Tokens are per-member, not per-message; rotate token after use (V2)                                  |

---

## 14. Anti-Patterns to Avoid

- **Don't send mail with the original sender's From header.** That's the Mailman trap. Always rewrite.
- **Don't reuse the sender's Message-ID for our outbound message.** Bounces will go to the wrong place.
- **Don't fan out synchronously in the inbound worker.** Always enqueue.
- **Don't parse MIME with regex.** Use `postal-mime`.
- **Don't store passwords.** Magic links only.
- **Don't put PII in URL path segments.** Tokens only. (Tenant slugs are public; member IDs are not.)
- **Don't add a frontend framework "to make the admin UI easier."** Plain HTML + TS works. React is for V2 once requirements are real.
- **Don't write a "comprehensive" config system.** Group settings live in D1. No YAML, no env-driven feature flags, no per-tenant override files.
- **Don't optimize for high-volume marketing senders.** This is for small group discussion. If the answer to a design question depends on "what if a tenant sends 100k emails an hour" — they're in the wrong product.
- **Don't trust `From` for membership check.** Use the SMTP envelope sender (return-path / Mail From) for validation, fall back to `From` only if missing. (Cloudflare Email Routing surfaces both.)
- **Don't skip the cross-client manual test (Gmail / Apple / Outlook desktop / Outlook web / Thunderbird) before calling threading "done."**

---

## 15. Repository Layout

```
bulletinmail/
├── package.json                 # pnpm workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── instance.config.example.json # template for per-instance config (apex, product name, ...)
├── LICENSE                      # AGPL-3.0
├── README.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── PRD.md                       # this file
├── .github/
│   └── workflows/
│       └── ci.yml
├── deployments/
│   └── bulletinmail.org/        # reference instance overlay (this maintainer's config)
│       ├── instance.config.json
│       └── README.md
├── docs/
│   ├── self-hosting.md          # deploy your own instance
│   ├── operations.md            # runbook for an operator
│   └── architecture.md          # extracts of this PRD for new contributors
├── scripts/
│   └── render-wrangler.ts       # merges instance.config.json into [vars] blocks
├── workers/
│   ├── inbound/
│   │   ├── src/index.ts         # email() handler
│   │   ├── src/handlers/
│   │   │   ├── resolve.ts       # recipient → (tenant, group)
│   │   │   ├── validate.ts      # posting policy
│   │   │   ├── store.ts         # D1 + R2 inserts
│   │   │   └── enqueue.ts       # fan out to queue
│   │   ├── tests/
│   │   └── wrangler.toml
│   ├── sender/
│   │   ├── src/index.ts         # queue() handler
│   │   ├── src/build.ts         # outbound MIME assembly
│   │   ├── tests/
│   │   └── wrangler.toml
│   └── web/                     # ALL HTTP — single wildcard route, host-based dispatch
│       ├── src/index.ts         # Hono app; classifyHost() → apex / admin / tenant
│       ├── src/landing.ts       # apex marketing landing (Phase 1 placeholder)
│       ├── src/routes/
│       │   ├── unsub.ts         # GET + POST /u/:token (RFC 8058)
│       │   ├── bounce.ts        # POST /api/bounce-events
│       │   ├── archive.ts       # GET /g/:tenant/:group (Phase 2/3)
│       │   ├── admin.ts         # admin app + admin API at app.<apex> (Phase 2)
│       │   └── tenant.ts        # catch-all for <slug>.<apex> hosts
│       ├── src/types.ts
│       ├── tests/
│       └── wrangler.toml        # routes = [{ pattern = "*<apex>/*", zone_name = "<apex>" }]
├── packages/
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 0001_init.sql
│   │   ├── src/index.ts         # typed query helpers
│   │   ├── src/types.ts
│   │   └── package.json
│   ├── mime/
│   │   ├── src/parse.ts         # wraps postal-mime
│   │   ├── src/build.ts         # outbound MIME assembly
│   │   ├── src/threading.ts     # parent resolution
│   │   ├── src/subject.ts       # prefix handling
│   │   ├── src/assertions.ts    # the invariants from §12
│   │   ├── tests/
│   │   └── package.json
│   └── shared/
│       ├── src/index.ts         # re-exports
│       ├── src/config.ts        # InstanceConfig type + loader
│       ├── src/host.ts          # classifyHost() — apex / admin / tenant dispatch
│       ├── src/slug.ts          # base reserved-subdomain list + slug validator
│       ├── src/time.ts          # time helpers
│       ├── src/ulid.ts          # ulid wrapper
│       ├── tests/
│       └── package.json
├── apps/
│   └── admin/                   # Phase 2 — Cloudflare Pages
│       ├── index.html
│       ├── src/
│       └── wrangler.toml
├── cli/
│   ├── src/index.ts             # commander/clipanion-style CLI
│   └── package.json
└── tests/
    ├── unit/                    # per-package vitest
    └── integration/
        └── full-pipeline.test.ts  # end-to-end via wrangler dev
```

---

## 16. Environment & Bindings

Cloudflare bindings (D1, R2, Queues, send_email) are declared in each Worker's `wrangler.toml` and committed to the repo. Plain-string `[vars]` (apex domain, admin domain, archive URL template, support addresses, product name) are **not** hand-edited — they are rendered from the active `instance.config.json` by `scripts/render-wrangler.ts` at deploy time, so that changing a tenant-facing label never requires touching four Worker configs. The committed `wrangler.toml` files below show the reference-instance values for readability; in practice the `[vars]` sections are regenerated. See §20 for the canonical config schema.

### `workers/inbound/wrangler.toml`
```toml
name = "bulletinmail-inbound"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[[d1_databases]]
binding = "DB"
database_name = "bulletinmail"
database_id = "..."

[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "bulletinmail-attachments"

[[queues.producers]]
binding = "SEND_QUEUE"
queue = "bulletinmail-send"

[vars]
APEX_DOMAIN = "bulletinmail.org"
ADMIN_DOMAIN = "app.bulletinmail.org"
```

### `workers/sender/wrangler.toml`
```toml
name = "bulletinmail-sender"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[[d1_databases]]
binding = "DB"
database_name = "bulletinmail"

[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "bulletinmail-attachments"

[[queues.consumers]]
queue = "bulletinmail-send"
max_batch_size = 10
max_concurrency = 10
max_retries = 3
dead_letter_queue = "bulletinmail-send-dlq"

[[send_email]]
name = "EMAIL"

[vars]
APEX_DOMAIN = "bulletinmail.org"
```

### `workers/web/wrangler.toml`
```toml
name = "bulletinmail-web"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# Single wildcard route — covers apex AND every subdomain in one declaration.
# (Same pattern relaytty.com uses; see §6.5.)
routes = [
  { pattern = "*bulletinmail.org/*", zone_name = "bulletinmail.org" }
]

[[d1_databases]]
binding = "DB"
database_name = "bulletinmail"

[observability]
enabled = true

[vars]
INSTANCE_APEX_DOMAIN = "bulletinmail.org"
# ... full INSTANCE_* block, rendered from instance.config.json
```

### Secrets (per worker, via `wrangler secret put`)
- `ADMIN_API_JWT_SECRET` (web only — Phase 2 admin sessions)
- `UNSUB_TOKEN_PEPPER` (web + sender)

---

## 17. Open Questions — Phase 0 Resolutions

Resolved 2026-05-25 via Cloudflare developer docs (links inline). Items 1, 2, 3, 4 are answered; item 5 stays deferred to V4.

1. **Wildcard subdomain Email Routing — RESOLVED (partial).** The HTTP side (Phase-0 verification of `*<apex>/*` Worker route) is confirmed working live on `bulletinmail.org` — a single route declaration covers apex + every subdomain. For inbound email, Cloudflare Email Routing's catch-all rule + an MX record on `*.<apex>` is the supported mechanism; live verification deferred to the post-deploy step in this same phase (catch-all rule wired to `bulletinmail-inbound`).
2. **Bounce / delivery event delivery — RESOLVED.** Cloudflare Email Service handles hard-bounce suppression *automatically* via an account-level suppression list ([deliverability docs](https://developers.cloudflare.com/email-service/concepts/deliverability/)) — recipients that hard-bounce are blocked from future sends without our intervention. Soft bounces are auto-retried with exponential backoff. For explicit per-event notification, Cloudflare's [Event Subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/) (Aug 2025) publish structured events to a Queue we can consume. V1 design: rely on platform suppression; expose `POST /api/bounce-events` in the web worker as a no-op webhook stub for future integration; track `bounce_count` for soft bounces if the Event Subscription source supports it.
3. **Email Sending rate limits — RESOLVED.** Per [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/):
   - **Daily quota:** per-account, varies by account standing, adjustable on request.
   - **Recipients per email:** 50 (combined to/cc/bcc).
   - **Subject:** 998 chars.
   - **Total message size:** 5 MiB regular, 25 MiB to verified addresses only.
   - **Headers:** 16 KB total, 20 max non-`X-` custom, 2048 bytes/value, 100 bytes/name.
   - **Workers binding extras:** 50 ms CPU, 50 subrequests, 128 MB memory.
   - **New accounts** can only send to *verified* addresses until Cloudflare lifts the restriction (paid plan = no restriction on recipients).

   Implications for fan-out: keep `max_concurrency = 10` on the send queue initially; revisit if we hit `E_RATE_LIMIT_EXCEEDED` or `E_DAILY_LIMIT_EXCEEDED`.
4. **Inbound message size cap — RESOLVED.** Cloudflare Email Routing accepts messages up to **25 MiB** ([routing limits](https://developers.cloudflare.com/email-routing/limits/)). For outbound, we are bounded by the 5 MiB Email Service cap, so the inbound worker must reject or rewrite anything over ~4.5 MiB (leaving headroom for header expansion in our outbound MIME). Per PRD §8.1, attachments >5 MB become R2 download links inline.
5. **Per-domain DKIM key automation (V4) — DEFERRED.** Out of scope for V1. Re-evaluate when BYO-domain work begins in Phase 4.

### New blockers discovered (in-flight)

6. **Outbound sender-domain authorization — RESOLVED (with workaround).** Verified empirically 2026-05-25: enabling Email Routing on `bulletinmail.org` authorizes sends only from `*@bulletinmail.org`, NOT from `*@<slug>.bulletinmail.org`. The Worker binding throws `Error: email sending not authorized for subdomain 'demo.bulletinmail.org'`. **Adopted workaround** (per the rejected-alternative escape hatch in §6): outbound `From` is `<tenant_slug>-<group>@<apex>` (slug-prefix on the local-part) while inbound `Reply-To` and `List-Post` remain on the tenant subdomain (`<group>@<slug>.<apex>`) where Email Routing's catch-all handles them. Code lives in `packages/mime/src/build.ts` (constants `outboundFromAddress` vs `inboundGroupAddress`). DMARC alignment is preserved — From-domain is the apex, which we DKIM-sign.

7. **SPF-record conflict blocks Email Routing enable (operational gotcha).** Discovered 2026-05-25 attempting to enable Email Routing on `bulletinmail.org`: the API returns `2026 Multiple SPF records exist` because the zone has two pre-existing SPF TXT records (`v=spf1 -all` and `v=spf1 ~all`, likely added by Cloudflare Registrar defaults). Email Routing refuses to proceed until exactly zero SPF records exist on the apex. Operator action required: delete every `v=spf1 ...` TXT record on the apex via the dashboard before clicking "Enable Email Routing" — Cloudflare then adds its own correct SPF. Documented in `docs/self-hosting.md` step 5.

---

## 18. References & Standards

- RFC 5322 — Internet Message Format
- RFC 2369 — Use of URLs as Meta-Syntax for Core Mail List Commands
- RFC 5064 — Archived-At header
- RFC 8058 — One-Click Unsubscribe
- RFC 7489 — DMARC
- RFC 6376 — DKIM
- RFC 7208 — SPF
- Cloudflare Email Routing — https://developers.cloudflare.com/email-routing/
- Cloudflare Email Service — https://developers.cloudflare.com/email-service/
- Cloudflare Queues — https://developers.cloudflare.com/queues/
- postal-mime — https://github.com/postalsys/postal-mime
- Gmail / Yahoo bulk sender requirements — https://support.google.com/mail/answer/81126

---

## 19. Distribution Model — Open Source + Reference Instance

BulletinMail is a deployable application, not a library. Licensing and packaging follow the playbook that has worked for Plausible, Cal.com, and Mattermost.

### License: AGPL-3.0-only

The whole product **is** the hosted service, so a license that closes the SaaS loophole protects the project's commercial viability without preventing genuine self-hosting. Anyone running BulletinMail as a service for third parties must publish their modifications. Internal use (a single church running its own copy for itself) carries no such obligation.

### Three-layer separation

The repository contains three concentric layers; downstream operators are expected to depend only on the inner two.

1. **Generic code** — `workers/`, `packages/`, `cli/`, `apps/`. Knows nothing about any specific deployment. Reads everything tenant-or-instance-specific from runtime config. Forks should rarely modify this layer.
2. **Instance overlay** — `deployments/<apex>/`. Per-deployment config, DNS notes, custom marketing copy, brand assets. The reference instance lives at `deployments/bulletinmail.org/`; an operator's fork adds their own sibling directory (or deletes ours from their fork).
3. **Hosted-only assets** (none in V1). If some future paid feature only ships on the hosted instance (e.g. consolidated billing across tenants), it lives in a separate private repository — never mixed into the OSS tree.

### Trademark and brand

The name "BulletinMail", the wordmark, and `bulletinmail.org` are trademarks of the project maintainer. The AGPL license covers **code only** — forks must rename when redistributing as a service (the Mattermost playbook). Self-hosting under a private brand or no brand is fine.

### Governance (V1)

Single-maintainer, BDFL model until contribution volume justifies more formal structure. No corporate CLA — contributors retain copyright; the project requires only the AGPL inbound = outbound grant via the Developer Certificate of Origin (DCO) sign-off in commits.

### What lives where — decision quick-reference

| Question                                       | Lives in                                        |
| ---------------------------------------------- | ----------------------------------------------- |
| "Change the product name to X"                 | `instance.config.json` (no code change)         |
| "Add a new reserved subdomain for our org"     | `instance.config.json`                          |
| "Change which support address handles abuse"   | `instance.config.json`                          |
| "Add our org's logo to the unsubscribe page"   | Instance overlay assets                         |
| "Change the threading algorithm"               | `packages/mime/src/threading.ts` (generic code) |
| "Add a new posting policy"                     | Generic code (schema + worker)                  |
| "Run a private fork with our own brand"        | Fork the repo, replace the overlay directory    |

---

## 20. Instance Configuration Manifest

Every value below is per-instance — these are exactly what distinguishes the reference deployment from any operator's fork. The canonical schema lives in `packages/shared/src/config.ts`. Loaded once at Worker startup; static-template values (HTML/email footers) are substituted at build time.

```ts
export type InstanceConfig = {
  // Identity
  apexDomain: string;            // e.g. "bulletinmail.org"
  adminDomain: string;           // e.g. "app.bulletinmail.org"
  productName: string;           // e.g. "BulletinMail"
  productNameShort: string;      // e.g. "Bulletin"
  tagline: string;               // shown in unsubscribe + footer templates

  // System addresses (local-parts only; combined with apexDomain at runtime)
  supportAddress: string;             // e.g. "support"
  abuseAddress: string;               // e.g. "abuse"
  dmarcAddress: string;               // e.g. "dmarc"
  noreplyAddress: string;             // e.g. "noreply"
  unsubscribeAddressPrefix: string;   // e.g. "unsubscribe+" (token appended)

  // URL templates ({tenant}, {group}, {token} interpolated)
  archiveUrlTemplate: string;    // e.g. "https://bulletinmail.org/g/{tenant}/{group}"
  unsubscribeUrlTemplate: string;// e.g. "https://bulletinmail.org/u/{token}"
  adminUrl: string;              // e.g. "https://app.bulletinmail.org"

  // Slug policy (merged with the base list in packages/shared/src/slug.ts)
  additionalReservedSlugs: string[]; // operator-specific extras
  minSlugLength: number;             // default 3
  maxSlugLength: number;             // default 40

  // Rate limits (per-tenant defaults; tenant rows may override individually)
  defaultDailyMessageLimitPerTenant: number;
  defaultMaxRecipientsPerGroup: number;

  // Operator metadata (rendered in footers, abuse reports, DMARC contact)
  operator: {
    legalName: string;
    mailingAddress: string;      // CAN-SPAM compliance
    contactUrl: string;          // e.g. "https://bulletinmail.org/contact"
  };

  // Feature toggles — keep this list small; not a substitute for code review
  features: {
    byoDomainEnabled: boolean;
    publicArchivesAllowed: boolean;   // master switch; per-group setting still applies
    signupSelfService: boolean;       // false for V1 (manual onboarding)
  };
};
```

### Sources of values

| Layer                 | Source                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| Generic defaults      | `packages/shared/src/config.ts` exports `defaults: Partial<InstanceConfig>`     |
| Reference deployment  | `deployments/bulletinmail.org/instance.config.json` (JSON, version-controlled)  |
| Operator deployment   | `deployments/<their-apex>/instance.config.json`                                 |
| Local dev             | `instance.config.local.json` at repo root (gitignored), falls back to reference |
| Runtime injection     | `scripts/render-wrangler.ts` merges layers, emits `[vars]` per Worker           |

### Out-of-band per-instance setup (operator actions, not config)

Each operator must do, once per deployment, with their own credentials:

1. Register and configure the apex domain in their own Cloudflare zone.
2. Apply DNS records (MX wildcard + apex, SPF, DKIM, DMARC) — template in `docs/self-hosting.md`.
3. Create D1 database, R2 bucket, send Queue, dead-letter Queue (commands documented).
4. Provision the Email Sending binding for the zone.
5. `wrangler secret put` for `ADMIN_API_JWT_SECRET` and `UNSUB_TOKEN_PEPPER`.
6. Run migrations (`pnpm db:migrate`).
7. Create the first tenant + admin (`pnpm cli create-tenant ...`).

The repo provides scripts for steps 3 and 6; steps 1, 2, 4, 5, 7 are documented but require operator action.

### Hard rule (enforced in CI)

**Generic code never imports a literal apex domain, product name, or system-address string.** A `grep -r "bulletinmail\\.org"` inside `workers/`, `packages/`, `cli/`, or `apps/` must return zero hits other than test fixtures. A CI check (`scripts/check-no-instance-leakage.sh`) fails the build if this changes.

---

## Appendix A — Worked Example: Outbound Message

Member `pastor.john@firstpresby.org` sends to `announcements@firstpresby.bulletinmail.org`:

```
From: Pastor John <pastor.john@firstpresby.org>
To: announcements@firstpresby.bulletinmail.org
Subject: Service tomorrow
Message-ID: <abc123@firstpresby.org>
Date: Sun, 24 May 2026 14:00:00 -0500

Sunday service is at 10am as usual. ...
```

Outbound to member `alice@example.com`:

```
From: "Pastor John via First Presby Announcements" <announcements@firstpresby.bulletinmail.org>
Reply-To: announcements@firstpresby.bulletinmail.org
To: alice@example.com
Subject: [Announcements] Service tomorrow
Message-ID: <01HXXXXXXXXXXXXXXXXXXXXXXX@firstpresby.bulletinmail.org>
Date: Sun, 24 May 2026 14:00:01 -0500
List-Id: <announcements.firstpresby.bulletinmail.org>
List-Post: <mailto:announcements@firstpresby.bulletinmail.org>
List-Archive: <https://bulletinmail.org/g/firstpresby/announcements>
List-Unsubscribe: <mailto:unsubscribe+TOKEN@bulletinmail.org>, <https://bulletinmail.org/u/TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
Precedence: list
Auto-Submitted: auto-generated
X-Original-From: pastor.john@firstpresby.org
X-Original-Message-ID: <abc123@firstpresby.org>

Sunday service is at 10am as usual. ...
```

Alice replies:

```
From: Alice <alice@example.com>
To: announcements@firstpresby.bulletinmail.org
Subject: Re: [Announcements] Service tomorrow
Message-ID: <def456@example.com>
In-Reply-To: <01HXXXXXXXXXXXXXXXXXXXXXXX@firstpresby.bulletinmail.org>
References: <01HXXXXXXXXXXXXXXXXXXXXXXX@firstpresby.bulletinmail.org>

Looking forward to it!
```

Inbound worker resolves: `In-Reply-To` matches an existing outbound `messages.id`. Threading parent found. New message gets `thread_id = parent.thread_id`. Outbound fan-out:

```
From: "Alice via First Presby Announcements" <announcements@firstpresby.bulletinmail.org>
Subject: [Announcements] Re: Service tomorrow
Message-ID: <01HYYYYYYYYYYYYYYYYYYYYYYY@firstpresby.bulletinmail.org>
In-Reply-To: <01HXXXXXXXXXXXXXXXXXXXXXXX@firstpresby.bulletinmail.org>
References: <01HXXXXXXXXXXXXXXXXXXXXXXX@firstpresby.bulletinmail.org>
...
```

Gmail threads it correctly with Pastor John's original.

---

*End of PRD. Iterate.*
