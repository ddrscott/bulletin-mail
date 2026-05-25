/**
 * Subscription-request moderation API.
 *
 *   GET    /api/groups/:id/pending                 list pending for the group
 *   POST   /api/groups/:id/pending/:reqId/approve  approve → insert member
 *   POST   /api/groups/:id/pending/:reqId/reject   reject with optional note
 *
 * Approval inserts a real `members` row (active, default delivery_mode). If
 * the email is already a member we still mark the request approved (admin
 * intent honored) but don't double-insert; the API returns 200 with `existing`.
 *
 * Rejection is a state change only — no email goes out to the rejector. The
 * applicant might be a spammer or hostile; we don't want to give them
 * confirmation that the address routes here.
 */

import type { Hono, Context } from "hono";
import {
  decideSubscriptionRequest,
  getGroupById,
  getMemberByEmail,
  getSubscriptionRequest,
  insertMember,
  listPendingSubscriptionRequests,
  type Group,
  type SubscriptionRequest,
} from "@bulletinmail/db";
import type { AppVariables, Env } from "../../types.js";
import { requireTenantAdmin } from "./tenant-middleware.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountPending(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/api/groups/:id/pending", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;
    const requests = await listPendingSubscriptionRequests(c.env.DB, group.id);
    return c.json({ requests: requests.map(serialize) });
  });

  app.post("/api/groups/:id/pending/:reqId/approve", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;
    const reqId = c.req.param("reqId");
    const admin = c.var.admin!;

    const subReq = await getSubscriptionRequest(c.env.DB, reqId);
    if (!subReq || subReq.group_id !== group.id) return c.json({ error: "not_found" }, 404);
    if (subReq.state !== "pending") return c.json({ error: "already_decided", state: subReq.state }, 409);

    // Claim the decision atomically — short-circuit if a concurrent click won.
    const claimed = await decideSubscriptionRequest(c.env.DB, reqId, "approved", admin.id, null);
    if (!claimed) return c.json({ error: "already_decided" }, 409);

    // Idempotent member insert. If they were added some other way between
    // submission and approval, don't double-insert; report the existing row.
    // status='active' here because the user already opted in via the public
    // subscribe form — no second confirmation needed.
    let memberId = await insertMember(c.env.DB, {
      groupId: group.id,
      email: subReq.email,
      displayName: subReq.display_name,
      role: "member",
      status: "active",
    });
    let existed = false;
    if (!memberId) {
      const existing = await getMemberByEmail(c.env.DB, group.id, subReq.email);
      memberId = existing?.id ?? null;
      existed = true;
    }

    return c.json({ memberId, existed }, 200);
  });

  app.post("/api/groups/:id/pending/:reqId/reject", requireTenantAdmin, async (c) => {
    const group = await loadGroupOr404(c);
    if (group instanceof Response) return group;
    const reqId = c.req.param("reqId");
    const admin = c.var.admin!;

    const body = await safeJson<{ note?: string | null }>(c.req.raw);
    const note = body?.note?.trim() || null;

    const subReq = await getSubscriptionRequest(c.env.DB, reqId);
    if (!subReq || subReq.group_id !== group.id) return c.json({ error: "not_found" }, 404);
    if (subReq.state !== "pending") return c.json({ error: "already_decided", state: subReq.state }, 409);

    const claimed = await decideSubscriptionRequest(c.env.DB, reqId, "rejected", admin.id, note);
    if (!claimed) return c.json({ error: "already_decided" }, 409);
    return c.body(null, 204);
  });
}

async function loadGroupOr404(c: Ctx): Promise<Group | Response> {
  const admin = c.var.admin!;
  const groupId = c.req.param("id");
  if (!groupId) return c.json({ error: "not_found" }, 404);
  const group = await getGroupById(c.env.DB, groupId);
  if (!group || group.tenant_id !== admin.tenant_id) return c.json({ error: "not_found" }, 404);
  return group;
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function serialize(r: SubscriptionRequest) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    about: r.about,
    state: r.state,
    createdAt: r.created_at,
  };
}
