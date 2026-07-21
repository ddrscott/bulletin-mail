/**
 * Weekly member digest (community hub 4/5).
 *
 * Distinct from ./digest.ts on purpose: that module is the DAILY moderator
 * digest (pending subscription requests → tenant admins). This one is the
 * weekly MEMBER digest — a recap of list + wiki activity sent to every
 * active member who hasn't opted out. Both stay; the scheduled handler
 * dispatches on the cron expression.
 *
 * Shape per tenant:
 *   1. Aggregate the last 7 days of thread activity from D1 (new threads vs
 *      active older threads, message + participant counts).
 *   2. Best-effort wiki activity via the web Worker's TenantWikiDO (bound
 *      cross-script). Failure → digest ships without the wiki section.
 *   3. For each recipient (distinct email, active membership, not opted
 *      out): filter sections to groups they may see (their groups + tenant
 *      'public' archives; 'none' never appears), skip entirely when empty,
 *      send plain HTML through the same EMAIL binding as list mail.
 *
 * No AI anywhere in this path — the digest is structured data (titles,
 * counts, permalinks), so it works on instances with search disabled.
 */

import {
  getOrCreateUnsubToken,
  listDigestRecipientsForTenant,
  listMemberGroupIds,
  listTenants,
  listWeeklyThreadActivity,
  type Tenant,
  type WeeklyThreadActivityRow,
} from "@bulletinmail/db";
import { systemAddress, tenantWebBase, type InstanceConfig } from "@bulletinmail/shared";

export const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Must match the weekly entry in wrangler.toml [triggers] EXACTLY — the
 *  scheduled handler compares event.cron against this string to dispatch. */
export const WEEKLY_DIGEST_CRON = "0 23 * * SUN";

export interface WeeklyDigestEnv {
  DB: D1Database;
  EMAIL: SendEmail;
  /** Cross-script binding to the web Worker's TenantWikiDO. Optional — a
   *  deploy without it (or with the web Worker missing) just loses the wiki
   *  section, never the digest. */
  WIKI?: DurableObjectNamespace;
}

/** Minimal slice of the DO's ActivityRow that the digest consumes. */
export type WikiActivityItem = {
  page_slug: string;
  page_title: string;
  edits: number;
  is_new: boolean;
};

export async function runWeeklyDigest(
  env: WeeklyDigestEnv,
  config: InstanceConfig,
  now: number = Date.now(),
): Promise<void> {
  const since = now - DIGEST_WINDOW_MS;
  const tenants = (await listTenants(env.DB)).filter((t) => t.status === "active");

  for (const tenant of tenants) {
    try {
      await sendTenantWeeklyDigest(env, config, tenant, since);
    } catch (err) {
      // Per-tenant isolation — one broken tenant must not starve the rest,
      // and we swallow (not rethrow) so a Cron retry can't double-send the
      // tenants that already succeeded.
      console.error(`weekly-digest: tenant ${tenant.id} failed`, err);
    }
  }
}

async function sendTenantWeeklyDigest(
  env: WeeklyDigestEnv,
  config: InstanceConfig,
  tenant: Tenant,
  since: number,
): Promise<void> {
  const threads = await listWeeklyThreadActivity(env.DB, tenant.id, since);
  const wikiItems = await fetchWikiActivity(env, tenant.slug, since);
  if (threads.length === 0 && wikiItems.length === 0) {
    return; // quiet week — no digest for anyone
  }

  const recipients = await listDigestRecipientsForTenant(env.DB, tenant.id);
  if (recipients.length === 0) return;

  const base = tenantWebBase(config, tenant.slug);
  const from = systemAddress(config, "noreply");

  for (const recipient of recipients) {
    try {
      const groupIds = new Set(await listMemberGroupIds(env.DB, tenant.id, recipient.email));
      const visible = filterThreadsForRecipient(threads, groupIds);
      // Empty digests are never sent — a member whose groups were all quiet
      // (and no wiki activity) hears nothing this week.
      if (visible.length === 0 && wikiItems.length === 0) continue;

      const optOutToken = await getOrCreateUnsubToken(env.DB, recipient.member_id);
      const mail = renderWeeklyDigestEmail({
        config,
        tenant,
        base,
        threads: visible,
        wikiItems,
        optOutUrl: `${base}/digest/unsub/${optOutToken}`,
      });

      await env.EMAIL.send({
        to: recipient.email,
        from,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: { "X-Bulletin-Purpose": "weekly-digest" },
      } as unknown as Parameters<SendEmail["send"]>[0]);
    } catch (err) {
      console.error(`weekly-digest: send to ${recipient.email} failed`, err);
    }
  }
}

/**
 * Wiki activity for the window, one item per page (edit count folded in),
 * public pages only. Best-effort: any failure returns [].
 */
async function fetchWikiActivity(
  env: WeeklyDigestEnv,
  tenantSlug: string,
  since: number,
): Promise<WikiActivityItem[]> {
  if (!env.WIKI) return [];
  try {
    const stub = env.WIKI.get(env.WIKI.idFromName(tenantSlug));
    const res = await stub.fetch("https://do.local/rpc/listRecentActivity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200 }),
    });
    if (!res.ok) throw new Error(`DO listRecentActivity ${res.status}`);
    const rows = (await res.json()) as Array<{
      page_id: string;
      page_slug: string;
      page_title: string;
      page_created_at: number;
      page_visibility: "public" | "private";
      created_at: number;
    }>;
    return summarizeWikiActivity(rows, since);
  } catch (err) {
    console.error(`weekly-digest: wiki activity for ${tenantSlug} unavailable`, err);
    return [];
  }
}

/** Pure: collapse version rows into one item per page. Exported for tests. */
export function summarizeWikiActivity(
  rows: Array<{
    page_id: string;
    page_slug: string;
    page_title: string;
    page_created_at: number;
    page_visibility: "public" | "private";
    created_at: number;
  }>,
  since: number,
): WikiActivityItem[] {
  const byPage = new Map<string, WikiActivityItem>();
  for (const r of rows) {
    if (r.created_at < since) continue;
    if (r.page_visibility === "private") continue;
    const existing = byPage.get(r.page_id);
    if (existing) {
      existing.edits++;
    } else {
      byPage.set(r.page_id, {
        page_slug: r.page_slug,
        page_title: r.page_title,
        edits: 1,
        is_new: r.page_created_at >= since,
      });
    }
  }
  return Array.from(byPage.values());
}

/**
 * Pure: threads this recipient may see. 'none' archives never appear;
 * 'public' means tenant-public (any member); 'members' requires active
 * membership in that group. Exported for tests.
 */
export function filterThreadsForRecipient(
  threads: WeeklyThreadActivityRow[],
  memberGroupIds: Set<string>,
): WeeklyThreadActivityRow[] {
  return threads.filter((t) => {
    if (t.archive_visibility === "none") return false;
    if (t.archive_visibility === "public") return true;
    return memberGroupIds.has(t.group_id);
  });
}

// ---- rendering --------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export type WeeklyDigestRenderInput = {
  config: InstanceConfig;
  tenant: Tenant;
  /** Tenant web origin (no trailing slash) — tenantWebBase(). */
  base: string;
  threads: WeeklyThreadActivityRow[];
  wikiItems: WikiActivityItem[];
  optOutUrl: string;
};

/**
 * Plain HTML email — inline styles only, no images, no layout tables, same
 * idiom as the moderator digest. Renders fine in Gmail/Apple Mail/Outlook
 * because there is nothing to break: headings, lists, links.
 */
export function renderWeeklyDigestEmail(input: WeeklyDigestRenderInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { tenant, base, wikiItems, optOutUrl } = input;
  const newThreads = input.threads.filter((t) => t.started_in_window);
  const activeThreads = input.threads.filter((t) => !t.started_in_window);

  const subject = `This week on ${tenant.display_name}`;

  // ---- text ----
  const text: string[] = [`Activity on ${tenant.display_name} this week:`, ""];
  const threadLine = (t: WeeklyThreadActivityRow): string[] => [
    `  • ${t.subject || "(no subject)"} [${t.group_display_name}]`,
    `    ${t.new_messages} message${t.new_messages === 1 ? "" : "s"}, ${t.participant_count} participant${t.participant_count === 1 ? "" : "s"} — ${base}/t/${t.thread_id}`,
  ];
  if (newThreads.length > 0) {
    text.push("New threads:");
    for (const t of newThreads) text.push(...threadLine(t));
    text.push("");
  }
  if (activeThreads.length > 0) {
    text.push("Active threads:");
    for (const t of activeThreads) text.push(...threadLine(t));
    text.push("");
  }
  if (wikiItems.length > 0) {
    text.push("Wiki:");
    for (const w of wikiItems) {
      text.push(
        `  • ${w.page_title} (${w.is_new ? "new page" : `${w.edits} edit${w.edits === 1 ? "" : "s"}`}) — ${base}/wiki/${w.page_slug}`,
      );
    }
    text.push("");
  }
  text.push(`Browse everything: ${base}/archive`);
  text.push("");
  text.push(`Stop the weekly digest (list mail is unaffected): ${optOutUrl}`);
  text.push(`— ${input.config.productName}`);

  // ---- html ----
  const threadItem = (t: WeeklyThreadActivityRow): string => `
    <li style="margin-bottom:0.5rem">
      <a href="${esc(`${base}/t/${t.thread_id}`)}" style="color:#0f172a;font-weight:600">${esc(t.subject || "(no subject)")}</a>
      <span style="color:#666;font-size:0.85rem"> · ${esc(t.group_display_name)} · ${t.new_messages} message${t.new_messages === 1 ? "" : "s"} · ${t.participant_count} participant${t.participant_count === 1 ? "" : "s"}</span>
    </li>`;
  const section = (title: string, items: string): string =>
    items ? `<h3 style="font-size:1rem;margin:1.25rem 0 0.4rem">${esc(title)}</h3><ul style="padding-left:1.2rem;margin:0">${items}</ul>` : "";

  const wikiHtml = wikiItems
    .map(
      (w) => `
    <li style="margin-bottom:0.5rem">
      <a href="${esc(`${base}/wiki/${w.page_slug}`)}" style="color:#0f172a;font-weight:600">${esc(w.page_title)}</a>
      <span style="color:#666;font-size:0.85rem"> · ${w.is_new ? "new page" : `${w.edits} edit${w.edits === 1 ? "" : "s"}`}</span>
    </li>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:1rem auto;padding:0 1rem;color:#222">
  <h2 style="font-size:1.15rem">This week on ${esc(tenant.display_name)}</h2>
  ${section("New threads", newThreads.map(threadItem).join(""))}
  ${section("Active threads", activeThreads.map(threadItem).join(""))}
  ${section("Wiki", wikiHtml)}
  <p style="margin-top:1.5rem"><a href="${esc(`${base}/archive`)}" style="display:inline-block;padding:0.55rem 1.1rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Browse the archive</a></p>
  <p style="margin-top:1.5rem;color:#666;font-size:0.8rem">You get this weekly summary because you're a member of ${esc(tenant.display_name)} lists.<br>
  <a href="${esc(optOutUrl)}" style="color:#666">Stop the weekly digest</a> — regular list mail is unaffected.</p>
</body></html>`;

  return { subject, text: text.join("\n"), html };
}
