#!/usr/bin/env -S npx tsx
/**
 * bulletin — operator CLI for BulletinMail.
 *
 * Commands (Phase 1, from PRD §11):
 *   bulletin create-tenant  --slug <slug> --name <name> --admin-email <email>
 *   bulletin create-group   --tenant <slug> --name <local> --display <name>
 *                           --policy <members|moderated|announce_only|open>
 *   bulletin add-member     --tenant <slug> --group <name> --email <email>
 *   bulletin remove-member  --tenant <slug> --group <name> --email <email>
 *   bulletin list-groups    --tenant <slug>
 *
 * Each command:
 *   1. Loads InstanceConfig from --instance flag (path to a
 *      deployments/<apex>/instance.config.json) or env.
 *   2. Validates inputs (slug rules via @bulletinmail/shared).
 *   3. Executes the corresponding SQL against D1 by shelling out to
 *      `wrangler d1 execute --remote --file=<tmp.sql>`. Wrangler does not
 *      accept parameterized queries via CLI, so values are escaped inline
 *      using TOML/SQL string-literal rules (single quotes doubled). Slugs
 *      and column names are never user-supplied at the SQL level.
 *
 * Phase 1: create-tenant, create-group, add-member implemented. The rest
 * (list-groups, remove-member) remain TODO; admins can use
 * `wrangler d1 execute --remote --command "SELECT ..."` directly until then.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@bulletinmail/shared";

import { Command } from "commander";
import { validateTenantSlug } from "@bulletinmail/shared";

const program = new Command();

program
  .name("bulletin")
  .description("Operator CLI for BulletinMail")
  .version("0.0.0");

// ---- D1 shell-out helpers -----------------------------------------------------

const DB_NAME = process.env["BULLETINMAIL_D1_NAME"] ?? "bulletinmail";

/** SQL string literal escape: single-quote, with internal `'` doubled. */
function s(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Run a SQL block against the active D1 via wrangler. */
function runSql(sql: string): string {
  const path = join(tmpdir(), `bulletin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
  writeFileSync(path, sql);
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", DB_NAME, "--remote", `--file=${path}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

const NOW = (): string => Date.now().toString();

// ---- commands -----------------------------------------------------------------

program
  .command("create-tenant")
  .description("Create a new tenant (church/org) and its first admin")
  .requiredOption("--slug <slug>", "DNS-safe tenant slug, e.g. 'firstpresby'")
  .requiredOption("--name <name>", "Display name, e.g. 'First Presbyterian'")
  .requiredOption("--admin-email <email>", "Email of the first admin")
  .action((opts: { slug: string; name: string; adminEmail: string }) => {
    const slugCheck = validateTenantSlug(opts.slug, {
      minSlugLength: 3,
      maxSlugLength: 40,
      additionalReservedSlugs: [],
    });
    if (!slugCheck.ok) throw new Error(`Invalid slug: ${slugCheck.reason}`);

    const tenantId = `t_${newUlid()}`;
    const adminId = `a_${newUlid()}`;
    const sql = `
INSERT INTO tenants (id, slug, display_name, plan, created_at, status) VALUES
  (${s(tenantId)}, ${s(slugCheck.slug)}, ${s(opts.name)}, 'free', ${NOW()}, 'active');
INSERT INTO admins (id, tenant_id, email, role, created_at) VALUES
  (${s(adminId)}, ${s(tenantId)}, ${s(opts.adminEmail.toLowerCase())}, 'admin', ${NOW()});
`.trim();
    runSql(sql);
    console.log(`Created tenant: ${slugCheck.slug} (${tenantId})`);
    console.log(`Admin added:    ${opts.adminEmail} (${adminId})`);
  });

program
  .command("create-group")
  .description("Create a new mailing list (group) within an existing tenant")
  .requiredOption("--tenant <slug>")
  .requiredOption("--name <local>", "Local-part of the list address, e.g. 'announcements'")
  .requiredOption("--display <display>", "Display name shown to recipients")
  .requiredOption(
    "--policy <policy>",
    "Posting policy: members | moderated | announce_only | open",
  )
  .option("--reply-to <policy>", "Reply-To policy: list | sender", "list")
  .option("--prefix <prefix>", "Subject prefix, e.g. '[Announcements]'")
  .action((opts: {
    tenant: string;
    name: string;
    display: string;
    policy: string;
    replyTo: string;
    prefix?: string;
  }) => {
    const validPolicies = new Set(["members", "moderated", "announce_only", "open"]);
    if (!validPolicies.has(opts.policy)) throw new Error(`Bad --policy: ${opts.policy}`);
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(opts.name)) {
      throw new Error(`Bad group --name '${opts.name}' (must match /^[a-z][a-z0-9-]*[a-z0-9]$/)`);
    }

    const groupId = `g_${newUlid()}`;
    const sql = `
INSERT INTO groups
  (id, tenant_id, name, display_name, posting_policy, reply_to_policy,
   subject_prefix, archive_visibility, max_message_size, created_at)
SELECT
  ${s(groupId)}, t.id, ${s(opts.name)}, ${s(opts.display)},
  ${s(opts.policy)}, ${s(opts.replyTo)},
  ${s(opts.prefix ?? null)}, 'members', 10485760, ${NOW()}
FROM tenants t WHERE t.slug = ${s(opts.tenant)};
`.trim();
    runSql(sql);
    console.log(`Created group: ${opts.name} (${groupId}) under tenant ${opts.tenant}`);
  });

program
  .command("add-member")
  .description("Add a member to a group")
  .requiredOption("--tenant <slug>")
  .requiredOption("--group <name>")
  .requiredOption("--email <email>")
  .option("--name <name>")
  .option("--role <role>", "member | moderator | sender_only", "member")
  .action((opts: {
    tenant: string;
    group: string;
    email: string;
    name?: string;
    role: string;
  }) => {
    const validRoles = new Set(["member", "moderator", "sender_only"]);
    if (!validRoles.has(opts.role)) throw new Error(`Bad --role: ${opts.role}`);

    const memberId = `m_${newUlid()}`;
    const sql = `
INSERT INTO members
  (id, group_id, email, display_name, role, delivery_mode, status, bounce_count, joined_at)
SELECT
  ${s(memberId)}, g.id, ${s(opts.email.toLowerCase())}, ${s(opts.name ?? null)},
  ${s(opts.role)}, 'each', 'active', 0, ${NOW()}
FROM groups g
JOIN tenants t ON t.id = g.tenant_id
WHERE t.slug = ${s(opts.tenant)} AND g.name = ${s(opts.group)};
`.trim();
    runSql(sql);
    console.log(`Added member: ${opts.email} → ${opts.tenant}/${opts.group} (${memberId})`);
  });

program
  .command("remove-member")
  .description("Mark a member as 'unsubscribed' (idempotent — does not delete)")
  .requiredOption("--tenant <slug>")
  .requiredOption("--group <name>")
  .requiredOption("--email <email>")
  .action((opts: { tenant: string; group: string; email: string }) => {
    const sql = `
UPDATE members SET status = 'unsubscribed'
WHERE email = ${s(opts.email.toLowerCase())}
  AND group_id IN (
    SELECT g.id FROM groups g
    JOIN tenants t ON t.id = g.tenant_id
    WHERE t.slug = ${s(opts.tenant)} AND g.name = ${s(opts.group)}
  );
`.trim();
    runSql(sql);
    console.log(`Unsubscribed: ${opts.email} from ${opts.tenant}/${opts.group}`);
  });

program
  .command("list-groups")
  .description("List all groups for a tenant with member counts")
  .requiredOption("--tenant <slug>")
  .action((opts: { tenant: string }) => {
    const sql = `
SELECT g.name AS group_name, g.display_name, g.posting_policy,
       (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.status = 'active') AS active_members
FROM groups g
JOIN tenants t ON t.id = g.tenant_id
WHERE t.slug = ${s(opts.tenant)}
ORDER BY g.name;
`.trim();
    console.log(runSql(sql));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
