/**
 * GET /api/groups — list every group for the current admin's tenant, with
 * active member count and last-message timestamp for the home screen.
 */

import type { Hono } from "hono";
import {
  createGroup,
  getGroupById,
  listGroupsByTenant,
  updateGroup,
  type ArchiveVisibility,
  type PostingPolicy,
  type ReplyToPolicy,
} from "@bulletinmail/db";
import type { AppVariables, Env } from "../../types.js";
import { requireTenantAdmin } from "./tenant-middleware.js";

const GROUP_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const VALID_POLICIES: ReadonlySet<PostingPolicy> = new Set(["members", "moderated", "announce_only", "open"]);
const VALID_REPLY_TO: ReadonlySet<ReplyToPolicy> = new Set(["list", "sender"]);
const VALID_VISIBILITY: ReadonlySet<ArchiveVisibility> = new Set(["members", "public", "none"]);
const MAX_MESSAGE_SIZE_HARD_CAP = 25 * 1024 * 1024; // Email Routing inbound cap (PRD §17 #4)
const DEFAULT_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

export function mountGroups(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/api/groups", requireTenantAdmin, async (c) => {
    const admin = c.var.admin!;
    const groups = await listGroupsByTenant(c.env.DB, admin.tenant_id);
    return c.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        displayName: g.display_name,
        description: g.description,
        postingPolicy: g.posting_policy,
        replyToPolicy: g.reply_to_policy,
        subjectPrefix: g.subject_prefix,
        archiveVisibility: g.archive_visibility,
        maxMessageSize: g.max_message_size,
        subscribeStatement: g.subscribe_statement,
        activeMemberCount: g.active_member_count,
        lastMessageAt: g.last_message_at,
        createdAt: g.created_at,
      })),
    });
  });

  app.post("/api/groups", requireTenantAdmin, async (c) => {
    const admin = c.var.admin!;
    const body = await safeJson<{
      name?: string;
      displayName?: string;
      description?: string | null;
      postingPolicy?: string;
      replyToPolicy?: string;
      subjectPrefix?: string | null;
      archiveVisibility?: string;
      maxMessageSize?: number;
      subscribeStatement?: string | null;
    }>(c.req.raw);

    const name = body?.name?.trim().toLowerCase();
    const displayName = body?.displayName?.trim();
    const postingPolicy = body?.postingPolicy as PostingPolicy | undefined;
    const replyToPolicy = (body?.replyToPolicy ?? "list") as ReplyToPolicy;
    const archiveVisibility = (body?.archiveVisibility ?? "members") as ArchiveVisibility;
    const subjectPrefix = body?.subjectPrefix?.trim() || null;
    const description = body?.description?.trim() || null;
    const maxMessageSize = body?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
    const subscribeStatement = body?.subscribeStatement === null
      ? null
      : body?.subscribeStatement?.trim() || null;

    if (!name || !GROUP_NAME_RE.test(name)) {
      return c.json({ error: "invalid_name", reason: "must match /^[a-z][a-z0-9-]*[a-z0-9]$/" }, 400);
    }
    if (!displayName) return c.json({ error: "missing_display_name" }, 400);
    if (!postingPolicy || !VALID_POLICIES.has(postingPolicy)) {
      return c.json({ error: "invalid_posting_policy" }, 400);
    }
    if (!VALID_REPLY_TO.has(replyToPolicy)) {
      return c.json({ error: "invalid_reply_to_policy" }, 400);
    }
    if (!VALID_VISIBILITY.has(archiveVisibility)) {
      return c.json({ error: "invalid_archive_visibility" }, 400);
    }
    if (!Number.isFinite(maxMessageSize) || maxMessageSize < 1 || maxMessageSize > MAX_MESSAGE_SIZE_HARD_CAP) {
      return c.json({ error: "invalid_max_message_size" }, 400);
    }

    const id = await createGroup(c.env.DB, {
      tenantId: admin.tenant_id,
      name,
      displayName,
      description,
      postingPolicy,
      replyToPolicy,
      subjectPrefix,
      archiveVisibility,
      maxMessageSize,
      subscribeStatement,
    });
    if (!id) return c.json({ error: "name_taken" }, 409);
    return c.json({ id }, 201);
  });

  app.patch("/api/groups/:id", requireTenantAdmin, async (c) => {
    const admin = c.var.admin!;
    const groupId = c.req.param("id");
    const group = await getGroupById(c.env.DB, groupId);
    if (!group || group.tenant_id !== admin.tenant_id) {
      return c.json({ error: "not_found" }, 404);
    }

    const body = await safeJson<{
      displayName?: string;
      description?: string | null;
      postingPolicy?: string;
      replyToPolicy?: string;
      subjectPrefix?: string | null;
      archiveVisibility?: string;
      maxMessageSize?: number;
      subscribeStatement?: string | null;
    }>(c.req.raw);
    if (!body) return c.json({ error: "empty_body" }, 400);

    const patch: Parameters<typeof updateGroup>[2] = {};
    if (body.displayName !== undefined) {
      const dn = body.displayName.trim();
      if (!dn) return c.json({ error: "empty_display_name" }, 400);
      patch.displayName = dn;
    }
    if (body.description !== undefined) {
      patch.description = body.description === null ? null : body.description.trim() || null;
    }
    if (body.postingPolicy !== undefined) {
      if (!VALID_POLICIES.has(body.postingPolicy as PostingPolicy)) {
        return c.json({ error: "invalid_posting_policy" }, 400);
      }
      patch.postingPolicy = body.postingPolicy as PostingPolicy;
    }
    if (body.replyToPolicy !== undefined) {
      if (!VALID_REPLY_TO.has(body.replyToPolicy as ReplyToPolicy)) {
        return c.json({ error: "invalid_reply_to_policy" }, 400);
      }
      patch.replyToPolicy = body.replyToPolicy as ReplyToPolicy;
    }
    if (body.subjectPrefix !== undefined) {
      const sp = body.subjectPrefix === null ? null : body.subjectPrefix.trim() || null;
      patch.subjectPrefix = sp;
    }
    if (body.archiveVisibility !== undefined) {
      if (!VALID_VISIBILITY.has(body.archiveVisibility as ArchiveVisibility)) {
        return c.json({ error: "invalid_archive_visibility" }, 400);
      }
      patch.archiveVisibility = body.archiveVisibility as ArchiveVisibility;
    }
    if (body.maxMessageSize !== undefined) {
      if (!Number.isFinite(body.maxMessageSize) || body.maxMessageSize < 1 || body.maxMessageSize > MAX_MESSAGE_SIZE_HARD_CAP) {
        return c.json({ error: "invalid_max_message_size" }, 400);
      }
      patch.maxMessageSize = body.maxMessageSize;
    }
    if (body.subscribeStatement !== undefined) {
      patch.subscribeStatement = body.subscribeStatement === null
        ? null
        : body.subscribeStatement.trim() || null;
    }

    const ok = await updateGroup(c.env.DB, groupId, patch);
    if (!ok) return c.body(null, 204); // no fields changed → still success-ish
    return c.body(null, 204);
  });
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
