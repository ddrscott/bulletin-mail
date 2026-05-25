/**
 * Daily-digest cron handler.
 *
 * For every tenant with at least one pending subscription request, send each
 * admin a single email listing the open requests. Driven by Cloudflare Cron
 * Triggers (configured in wrangler.toml as `[triggers] crons = ["..."]`).
 *
 * Failure of a single tenant's digest does not abort the whole run — we log
 * + continue. Cloudflare retries the scheduled invocation if it throws, so
 * we explicitly swallow per-tenant errors to avoid duplicate sends on retry.
 */

import {
  listAdminsByTenant,
  listPendingSubscriptionsForTenant,
  listTenantsWithPending,
  getTenantById,
  type PendingForTenantRow,
  type Tenant,
} from "@bulletinmail/db";
import { systemAddress, type InstanceConfig } from "@bulletinmail/shared";

export interface DigestEnv {
  DB: D1Database;
  EMAIL: SendEmail;
}

export async function runDailyDigest(env: DigestEnv, config: InstanceConfig): Promise<void> {
  const tenantIds = await listTenantsWithPending(env.DB);
  if (tenantIds.length === 0) {
    console.log("daily-digest: no pending requests across any tenant");
    return;
  }

  for (const tenantId of tenantIds) {
    try {
      await sendTenantDigest(env, config, tenantId);
    } catch (err) {
      console.error(`daily-digest: tenant ${tenantId} failed`, err);
    }
  }
}

async function sendTenantDigest(env: DigestEnv, config: InstanceConfig, tenantId: string): Promise<void> {
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant || tenant.status !== "active") return;

  const [admins, pending] = await Promise.all([
    listAdminsByTenant(env.DB, tenantId),
    listPendingSubscriptionsForTenant(env.DB, tenantId),
  ]);
  if (admins.length === 0 || pending.length === 0) return;

  const from = systemAddress(config, "noreply");
  const adminUrl = config.adminUrl;
  const mail = renderDigestEmail(config, tenant, pending, adminUrl);

  for (const admin of admins) {
    const payload = {
      to: admin.email,
      from,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: {
        "X-Bulletin-Purpose": "moderator-digest",
      },
    };
    try {
      await env.EMAIL.send(payload as unknown as Parameters<SendEmail["send"]>[0]);
    } catch (err) {
      console.error(`daily-digest: send to ${admin.email} failed`, err);
    }
  }
}

function renderDigestEmail(
  config: InstanceConfig,
  tenant: Tenant,
  pending: PendingForTenantRow[],
  adminUrl: string,
): { subject: string; text: string; html: string } {
  // Group pending rows by group_id for tidy presentation.
  const byGroup = new Map<string, PendingForTenantRow[]>();
  for (const row of pending) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row);
    byGroup.set(row.group_id, list);
  }

  const subject = `${pending.length} pending ${pending.length === 1 ? "subscription" : "subscriptions"} — ${tenant.display_name}`;

  const textLines: string[] = [
    `${pending.length} subscription request${pending.length === 1 ? "" : "s"} are awaiting review for ${tenant.display_name}.`,
    "",
  ];
  for (const [, rows] of byGroup) {
    textLines.push(`  ${rows[0]!.group_display_name} (${rows[0]!.group_name}):`);
    for (const r of rows) {
      textLines.push(`    • ${r.display_name} <${r.email}>  — submitted ${new Date(r.created_at).toISOString().slice(0, 10)}`);
      if (r.about) textLines.push(`        “${r.about.replace(/\s+/g, " ").slice(0, 120)}”`);
    }
    textLines.push("");
  }
  textLines.push(`Review and approve at: ${adminUrl}`);
  textLines.push("");
  textLines.push(`— ${config.productName}`);

  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const htmlGroups = Array.from(byGroup.values())
    .map((rows) => {
      const items = rows.map((r) => `
        <li style="margin-bottom:0.4rem">
          <strong>${esc(r.display_name)}</strong> &lt;${esc(r.email)}&gt;
          <span style="color:#666;font-size:0.85rem"> · ${new Date(r.created_at).toISOString().slice(0, 10)}</span>
          ${r.about ? `<div style="color:#444;font-size:0.9rem;margin-top:0.15rem">${esc(r.about).slice(0, 240)}${r.about.length > 240 ? "…" : ""}</div>` : ""}
        </li>`).join("");
      return `<h3 style="font-size:1rem;margin:1rem 0 0.3rem">${esc(rows[0]!.group_display_name)}</h3><ul style="padding-left:1.2rem;margin:0">${items}</ul>`;
    })
    .join("");

  const html = `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:1rem auto;padding:0 1rem;color:#222">
  <h2 style="font-size:1.15rem">${esc(tenant.display_name)} — pending subscriptions</h2>
  <p>${pending.length} request${pending.length === 1 ? "" : "s"} ${pending.length === 1 ? "is" : "are"} awaiting review.</p>
  ${htmlGroups}
  <p style="margin-top:1.5rem"><a href="${esc(adminUrl)}" style="display:inline-block;padding:0.55rem 1.1rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Review in ${esc(config.productName)}</a></p>
</body></html>`;

  return { subject, text: textLines.join("\n"), html };
}
