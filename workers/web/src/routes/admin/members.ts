/**
 * Members CRUD + CSV bulk import.
 *
 * Every route verifies that the requested group belongs to the current admin's
 * tenant — D1 row checks, not URL trust. A cross-tenant `:id` returns 404 to
 * avoid leaking existence.
 *
 * CSV bulk paths:
 *   POST /api/groups/:id/members/bulk-preview {csv}  → dry-run, no DB writes
 *   POST /api/groups/:id/members/bulk {emails}       → commit, returns added/skipped
 *
 * Parsing tolerates: one address per line, `Name <email>` form, ',' or ';'
 * separators on a line. We deliberately don't pull in a CSV library — this
 * is closer to "mailing-list style" than RFC 4180.
 */

import type { Hono, Context } from "hono";
import {
  getGroupById,
  getMemberByEmail,
  getMemberById,
  getOrCreateUnsubToken,
  getTenantById,
  insertMember,
  listMembersByGroup,
  setMemberStatus,
  updateMemberRole,
  type Group,
  type MemberRole,
  type Tenant,
} from "@bulletinmail/db";
import {
  fetchGravatarDisplayName,
  systemAddress,
  unsubscribeUrl,
  type InstanceConfig,
} from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import { requireTenantAdmin } from "./tenant-middleware.js";

const VALID_ROLES: ReadonlySet<MemberRole> = new Set(["member", "moderator", "sender_only"]);

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountMembers(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  // List.
  app.get("/api/groups/:id/members", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;

    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
    const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);
    const members = await listMembersByGroup(c.env.DB, group.id, { limit, offset });
    return c.json({
      members: members.map(serializeMember),
    });
  });

  // Add one.
  app.post("/api/groups/:id/members", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;

    const body = await safeJson<{ email?: string; displayName?: string | null; role?: string }>(c.req.raw);
    const email = body?.email?.trim().toLowerCase();
    if (!email || !looksLikeEmail(email)) {
      return c.json({ error: "invalid_email" }, 400);
    }
    const role = (body?.role ?? "member") as MemberRole;
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "invalid_role" }, 400);
    }

    // Fall back to Gravatar profile name when the admin didn't supply one.
    // Best-effort — null on miss; the email's local-part isn't a great
    // display name but we leave display_name null and let the UI handle it.
    let displayName = body?.displayName?.trim() || null;
    if (!displayName) displayName = await fetchGravatarDisplayName(email);

    const id = await insertMember(c.env.DB, {
      groupId: group.id,
      email,
      displayName,
      role,
    });
    if (!id) {
      const existing = await getMemberByEmail(c.env.DB, group.id, email);
      return c.json({ error: "duplicate", member: existing ? serializeMember(existing) : null }, 409);
    }
    c.executionCtx.waitUntil(sendConfirmationEmail(c, id, group));
    return c.json({ id }, 201);
  });

  // Bulk preview — must come BEFORE /:memberId so Hono matches the literal path.
  app.post("/api/groups/:id/members/bulk-preview", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;

    const body = await safeJson<{ csv?: string }>(c.req.raw);
    const parsed = parseBulkEmails(body?.csv ?? "");
    const existing = await loadExistingEmailSet(c, group.id, parsed.valid);
    const toAdd: string[] = [];
    const duplicates: string[] = [];
    for (const email of parsed.valid) {
      if (existing.has(email)) duplicates.push(email);
      else toAdd.push(email);
    }
    return c.json({
      toAdd,
      duplicates,
      invalid: parsed.invalid,
      total: parsed.valid.length + parsed.invalid.length,
    });
  });

  // Bulk commit.
  app.post("/api/groups/:id/members/bulk", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;

    const body = await safeJson<{ emails?: string[] }>(c.req.raw);
    const incoming = Array.isArray(body?.emails) ? body!.emails : [];
    const added: string[] = [];
    const skipped: string[] = [];
    const invalid: string[] = [];

    const addedIds: string[] = [];
    // Bulk: fetch Gravatar names in parallel (Gravatar's 5s timeout means a
    // batch of 50 takes max ~5s end-to-end, not 250s sequential).
    const candidates = incoming
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim().toLowerCase());
    const invalidEmails = candidates.filter((e) => !looksLikeEmail(e));
    invalid.push(...invalidEmails);
    const validEmails = candidates.filter((e) => looksLikeEmail(e));
    const names = await Promise.all(validEmails.map((e) => fetchGravatarDisplayName(e)));
    for (let i = 0; i < validEmails.length; i++) {
      const email = validEmails[i]!;
      const id = await insertMember(c.env.DB, {
        groupId: group.id,
        email,
        displayName: names[i] ?? null,
        role: "member",
      });
      if (id) {
        added.push(email);
        addedIds.push(id);
      } else {
        skipped.push(email);
      }
    }
    // Fan out confirmation emails after the response — one per new member.
    c.executionCtx.waitUntil(
      Promise.all(addedIds.map((id) => sendConfirmationEmail(c, id, group))),
    );
    return c.json({ added, skipped, invalid });
  });

  // Role change. PATCH semantics: only `role` is updatable in V1.
  app.patch("/api/groups/:id/members/:memberId", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;
    const memberId = c.req.param("memberId");

    const body = await safeJson<{ role?: string }>(c.req.raw);
    if (!body?.role || !VALID_ROLES.has(body.role as MemberRole)) {
      return c.json({ error: "invalid_role" }, 400);
    }
    const changed = await updateMemberRole(c.env.DB, memberId, body.role as MemberRole);
    if (!changed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  // Remove = mark unsubscribed (PRD §8.4 — never delete; FK targets stay valid).
  app.delete("/api/groups/:id/members/:memberId", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;
    const memberId = c.req.param("memberId");

    const changed = await setMemberStatus(c.env.DB, memberId, "unsubscribed");
    if (!changed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
}

// ---- helpers ----------------------------------------------------------------

async function loadGroupOr404(c: Ctx): Promise<Group | Response> {
  const admin = c.var.admin!;
  const groupId = c.req.param("id");
  if (!groupId) return c.json({ error: "not_found" }, 404);
  const group = await getGroupById(c.env.DB, groupId);
  if (!group || group.tenant_id !== admin.tenant_id) {
    return c.json({ error: "not_found" }, 404);
  }
  return group;
}

async function loadExistingEmailSet(c: Ctx, groupId: string, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  // Chunk in case a paste is huge — D1 caps bound-param count per statement.
  const set = new Set<string>();
  const CHUNK = 50;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await c.env.DB
      .prepare(
        `SELECT email FROM members WHERE group_id = ? AND email IN (${placeholders})`,
      )
      .bind(groupId, ...chunk)
      .all<{ email: string }>();
    for (const row of results ?? []) set.add(row.email);
  }
  return set;
}

function serializeMember(m: import("@bulletinmail/db").Member) {
  return {
    id: m.id,
    email: m.email,
    displayName: m.display_name,
    role: m.role,
    deliveryMode: m.delivery_mode,
    status: m.status,
    bounceCount: m.bounce_count,
    lastBounceAt: m.last_bounce_at,
    joinedAt: m.joined_at,
  };
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Double-opt-in confirmation email. Sent after an admin adds a member; the
 * member must click the confirm link before they receive any list mail.
 * Token is the same opaque per-member unsub token — confirm uses /c/<token>,
 * decline reuses the existing /u/<token> unsubscribe flow.
 */
async function sendConfirmationEmail(
  c: Ctx,
  memberId: string,
  group: Group,
): Promise<void> {
  const config = c.var.config;
  const member = await getMemberById(c.env.DB, memberId);
  if (!member) return;
  const tenant: Tenant | null = c.var.admin
    ? await getTenantById(c.env.DB, c.var.admin.tenant_id)
    : null;
  if (!tenant) return;

  const token = await getOrCreateUnsubToken(c.env.DB, memberId);
  const confirmUrl = `https://${config.apexDomain}/c/${token}`;
  const declineUrl = unsubscribeUrl(config, token);
  const from = systemAddress(config, "noreply");

  const subject = `Confirm your subscription to ${group.display_name}`;
  const text = [
    `An admin at ${tenant.display_name} added ${member.email} to the ${group.display_name} mailing list.`,
    "",
    "You won't receive any messages until you confirm:",
    confirmUrl,
    "",
    "If you didn't expect this, decline here:",
    declineUrl,
    "",
    `— ${config.productName}`,
  ].join("\n");
  const html = renderConfirmHtml(config, tenant, group, member, confirmUrl, declineUrl);

  try {
    await c.env.EMAIL.send({
      to: member.email,
      from,
      subject,
      text,
      html,
      headers: { "X-Bulletin-Purpose": "member-confirmation" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("confirmation email send failed", { memberId, err: String(err) });
  }
}

function renderConfirmHtml(
  config: InstanceConfig,
  tenant: Tenant,
  group: Group,
  member: import("@bulletinmail/db").Member,
  confirmUrl: string,
  declineUrl: string,
): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.2rem">Confirm your subscription</h1>
<p>An admin at <strong>${esc(tenant.display_name)}</strong> added <strong>${esc(member.email)}</strong> to the <strong>${esc(group.display_name)}</strong> mailing list.</p>
<p>You won't receive any messages until you confirm.</p>
<p>
  <a href="${esc(confirmUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px;margin-right:0.5rem">Yes, subscribe me</a>
  <a href="${esc(declineUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;color:#0f172a;text-decoration:none;border:1px solid #0f172a;border-radius:4px">No, decline</a>
</p>
<p style="color:#666;font-size:0.875rem">Or paste these URLs into your browser:</p>
<p style="color:#666;font-size:0.875rem">Confirm: <code>${esc(confirmUrl)}</code></p>
<p style="color:#666;font-size:0.875rem">Decline: <code>${esc(declineUrl)}</code></p>
<p style="color:#666;font-size:0.875rem">— ${esc(config.productName)}</p>
</body></html>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s) && s.length <= 254;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * Parse a free-form paste into a list of plausible email addresses.
 *
 * Accepts one address per line; on each line, splits on commas / semicolons
 * too. Strips `Name <email>` form (keeps the bracketed address). Emails are
 * lowercased + deduped. Anything that fails `EMAIL_RE` lands in `invalid`.
 */
export function parseBulkEmails(input: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const line of input.split(/\r?\n/)) {
    for (const piece of line.split(/[,;]+/)) {
      const token = piece.trim();
      if (!token) continue;
      const angle = token.match(/<([^>]+)>/);
      const candidate = (angle ? angle[1]! : token).trim().toLowerCase();
      if (!candidate) continue;
      if (looksLikeEmail(candidate)) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          valid.push(candidate);
        }
      } else {
        invalid.push(token);
      }
    }
  }
  return { valid, invalid };
}
