/**
 * Team management — tenant admins promote/demote moderators.
 *
 *   GET    /api/team                 list admins + moderators for current tenant
 *   POST   /api/team                 { email, role } → add (sends magic link)
 *   PATCH  /api/team/:id             { role }        → change role
 *   DELETE /api/team/:id             remove from tenant
 *
 * Authorization: only role='admin' may invite or change roles. Moderators
 * are visible via GET but can't mutate.
 *
 * Safety: cannot demote/remove the LAST admin of a tenant — there must always
 * be at least one admin who can manage the team.
 */

import type { Hono, Context } from "hono";
import {
  createMagicLink,
  deleteTenantAdmin,
  getAdminById,
  insertTenantAdmin,
  listAdminsByTenant,
  updateAdminRole,
  type AdminRole,
} from "@bulletinmail/db";
import { fetchGravatarDisplayName, systemAddress } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../../types.js";
import { requireTenantAdmin, requireTenantAdminRole } from "./tenant-middleware.js";

const VALID_ROLES: ReadonlySet<AdminRole> = new Set(["admin", "moderator"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountTeam(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/api/team", requireTenantAdmin, async (c) => {
    const tenant = c.var.tenant!;
    const list = await listAdminsByTenant(c.env.DB, tenant.id);
    return c.json({
      team: list.map((a) => ({
        id: a.id, email: a.email, role: a.role, createdAt: a.created_at,
      })),
    });
  });

  app.post("/api/team", requireTenantAdmin, requireTenantAdminRole, async (c) => {
    const tenant = c.var.tenant!;
    const body = await safeJson<{ email?: string; role?: string }>(c.req.raw);
    const email = body?.email?.trim().toLowerCase();
    const role = (body?.role ?? "moderator") as AdminRole;
    if (!email || !EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);
    if (!VALID_ROLES.has(role)) return c.json({ error: "invalid_role" }, 400);

    const displayName = await fetchGravatarDisplayName(email);
    const adminId = await insertTenantAdmin(c.env.DB, {
      tenantId: tenant.id, email, role, displayName,
    });
    if (!adminId) return c.json({ error: "email_taken" }, 409);

    // Send a sign-in link so the new admin/moderator can immediately sign in.
    c.executionCtx.waitUntil(sendInviteEmail(c, adminId, email, role));
    return c.json({ id: adminId, role }, 201);
  });

  app.patch("/api/team/:id", requireTenantAdmin, requireTenantAdminRole, async (c) => {
    const tenant = c.var.tenant!;
    const adminId = c.req.param("id");
    const body = await safeJson<{ role?: string }>(c.req.raw);
    if (!body?.role || !VALID_ROLES.has(body.role as AdminRole)) {
      return c.json({ error: "invalid_role" }, 400);
    }
    const role = body.role as AdminRole;

    const target = await getAdminById(c.env.DB, adminId);
    if (!target || target.tenant_id !== tenant.id) return c.json({ error: "not_found" }, 404);

    // Safety: don't allow demoting the last admin.
    if (target.role === "admin" && role !== "admin") {
      const all = await listAdminsByTenant(c.env.DB, tenant.id);
      const adminCount = all.filter((a) => a.role === "admin").length;
      if (adminCount <= 1) {
        return c.json({ error: "last_admin", reason: "Cannot demote the only admin." }, 409);
      }
    }
    await updateAdminRole(c.env.DB, adminId, role);
    return c.body(null, 204);
  });

  app.delete("/api/team/:id", requireTenantAdmin, requireTenantAdminRole, async (c) => {
    const tenant = c.var.tenant!;
    const adminId = c.req.param("id");
    const target = await getAdminById(c.env.DB, adminId);
    if (!target || target.tenant_id !== tenant.id) return c.json({ error: "not_found" }, 404);

    // Safety: don't allow removing the last admin.
    if (target.role === "admin") {
      const all = await listAdminsByTenant(c.env.DB, tenant.id);
      const adminCount = all.filter((a) => a.role === "admin").length;
      if (adminCount <= 1) {
        return c.json({ error: "last_admin", reason: "Cannot remove the only admin." }, 409);
      }
    }
    await deleteTenantAdmin(c.env.DB, adminId);
    return c.body(null, 204);
  });
}

async function sendInviteEmail(
  c: Ctx,
  adminId: string,
  email: string,
  role: AdminRole,
): Promise<void> {
  const config = c.var.config;
  const tenant = c.var.tenant!;
  const host = c.req.header("Host") ?? `${tenant.slug}.${config.apexDomain}`;
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let token = "";
  for (let i = 0; i < buf.length; i++) token += buf[i]!.toString(16).padStart(2, "0");
  await createMagicLink(c.env.DB, token, adminId, Date.now() + MAGIC_LINK_LIFETIME_MS);

  const verifyUrl = `https://${host}/auth/verify?token=${token}`;
  const from = systemAddress(config, "noreply");
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const roleLabel = role === "admin" ? "admin" : "moderator";
  try {
    await c.env.EMAIL.send({
      to: email, from,
      subject: `You've been added as a ${roleLabel} for ${tenant.display_name}`,
      text: `You've been added as a ${roleLabel} for ${tenant.display_name} on ${config.productName}.\n\nSign in to get started:\n${verifyUrl}\n\nLink expires in 15 minutes.`,
      html: `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Welcome to ${esc(tenant.display_name)}</h1>
<p>You've been added as a <strong>${esc(roleLabel)}</strong>.</p>
<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:0.6rem 1.2rem;background:#0f172a;color:#fff;text-decoration:none;border-radius:4px">Sign in</a></p>
<p style="color:#666;font-size:0.875rem">Link expires in 15 minutes.</p>
</body></html>`,
      headers: { "X-Bulletin-Purpose": "team-invite" },
    } as unknown as Parameters<SendEmail["send"]>[0]);
  } catch (err) {
    console.error("team invite send failed", err);
  }
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}
