# `bulletin` CLI reference

Operator CLI for BulletinMail. Source: `cli/src/index.ts`.

## Synopsis

```
bulletin <command> [options]
```

Commands shell out to `wrangler d1 execute --remote --file=<tmp>` to run parameterized SQL against the D1 database named `bulletinmail` (override via env var `BULLETINMAIL_D1_NAME`). Wrangler must be authenticated to the account that owns the D1 database.

## Commands

### `create-tenant`

Create a new tenant (church/org) and its first admin.

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--slug <slug>` | yes | DNS-safe tenant slug. Validated by `validateTenantSlug` in `@bulletinmail/shared`. |
| `--name <name>` | yes | Display name shown to members. |
| `--admin-email <email>` | yes | Email of the first admin. Lowercased before insert. |

**Inserts:** one row into `tenants`, one row into `admins`. Tenant id and admin id are generated as ulids (with `t_` and `a_` prefixes).

**Exit:** `0` on success. Non-zero on validation failure or D1 error.

### `create-group`

Create a new mailing list (group) within an existing tenant.

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--tenant <slug>` | yes | Slug of an existing tenant. |
| `--name <local>` | yes | Local-part of the list address (e.g. `announcements`). Must match `/^[a-z][a-z0-9-]*[a-z0-9]$/`. |
| `--display <name>` | yes | Display name shown to recipients. |
| `--policy <policy>` | yes | Posting policy. One of `members`, `moderated`, `announce_only`, `open`. |
| `--reply-to <policy>` | no | Reply-To policy. One of `list`, `sender`. Default: `list`. |
| `--prefix <prefix>` | no | Subject prefix (e.g. `[Announcements]`). |

**Inserts:** one row into `groups` with `archive_visibility='members'`, `max_message_size=10485760`.

### `add-member`

Add a member to a group.

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--tenant <slug>` | yes | Tenant slug. |
| `--group <name>` | yes | Group local-part. |
| `--email <email>` | yes | Member email. Lowercased before insert. |
| `--name <name>` | no | Display name. |
| `--role <role>` | no | One of `member`, `moderator`, `sender_only`. Default: `member`. |

**Inserts:** one row into `members` with `delivery_mode='each'`, `status='active'`, `bounce_count=0`.

### `remove-member`

Mark a member as `unsubscribed`. Does not delete; the row remains for audit and idempotent reactivation.

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--tenant <slug>` | yes | Tenant slug. |
| `--group <name>` | yes | Group local-part. |
| `--email <email>` | yes | Member email. |

**Updates:** `members.status = 'unsubscribed'` for the matched row.

### `list-groups`

List groups for a tenant with active-member counts.

**Options:**

| Flag | Required | Description |
|------|----------|-------------|
| `--tenant <slug>` | yes | Tenant slug. |

**Output:** raw `wrangler d1 execute` JSON for `SELECT g.name, g.display_name, g.posting_policy, COUNT(members WHERE status='active') ...`.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `BULLETINMAIL_D1_NAME` | `bulletinmail` | D1 database name passed to `wrangler d1 execute`. |

## Invocation

The CLI ships as a TypeScript file with a `tsx` shebang. From the repo root:

```sh
node --import tsx/esm cli/src/index.ts <command> [options]
# or
pnpm cli <command> [options]
```

## SQL escaping

The CLI generates SQL string literals with single quotes doubled. Identifiers (table and column names) are never user-supplied at the SQL layer. There is no transaction wrapper; each command runs a single statement.
