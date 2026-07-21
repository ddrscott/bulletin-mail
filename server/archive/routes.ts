/**
 * Archive browser — read-only web view of list threads, served on the
 * tenant subdomain (<tenant>.<apex>; in single-tenant mode the apex itself
 * classifies as the tenant, so the same routes fire there unchanged).
 *
 *   GET  /archive               group (list) index the viewer may browse
 *   GET  /archive/:group        thread list, newest activity first, paginated
 *   GET  /t/:threadId           thread permalink — messages in thread order
 *   GET  /archive/att/:id       attachment download (auth-checked, R2)
 *   POST /auth/verify-code      6-digit code form (admin first, then member)
 *
 * Access model (task acceptance):
 *   - tenant admins/moderators (bm_tenant_session) see every group whose
 *     archive_visibility != 'none'
 *   - members (bm_member_session) see groups they actively belong to, plus
 *     tenant-public groups (archive_visibility = 'public')
 *   - archive_visibility = 'none' hides a group from the archive entirely
 *   - everything requires a signed-in viewer — 'public' here means
 *     tenant-public, not internet-public (PRD §12 #5 stays intact)
 */

import type { Hono, Context } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import {
  consumeMagicLinkByCode,
  consumeMemberMagicLinkByCode,
  countThreadsByGroup,
  getAttachmentWithMessage,
  getGroupById,
  getGroupByLocalpart,
  getTenantBySlug,
  listAttachmentsByThread,
  listGroupsByTenant,
  listMessagesByThread,
  listThreadsByGroup,
  type Admin,
  type Attachment,
  type Group,
  type Tenant,
} from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import { resolveTenantContext, buildTenantSetCookie, issueTenantSessionCookie } from "../wiki/tenant-auth.js";
import {
  buildMemberSetCookie,
  issueMemberSessionCookie,
  resolveMemberContext,
} from "./member-auth.js";
import { normalizeContentId, renderPlainTextBody, sanitizeEmailHtml } from "./sanitize.js";
import {
  renderGroupIndexPage,
  renderThreadListPage,
  renderThreadPage,
  type RenderedMessage,
} from "./render.js";
import { renderSignInSentPage } from "../wiki/editor.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const PAGE_SIZE = 50;
const GROUP_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const SIX_DIGIT_RE = /^\d{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ArchiveViewer =
  | { kind: "admin"; admin: Admin; label: string }
  | { kind: "member"; email: string; groupIds: Set<string>; label: string };

export function mountArchiveRoutes(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
): void {
  // ---- group index ---------------------------------------------------------
  app.get("/archive", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const groups = (await listGroupsByTenant(c.env.DB, tenant.id))
      .filter((g) => canViewGroup(viewer, g));
    return c.html(renderGroupIndexPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      groups,
    }));
  }));

  // ---- attachment download (registered before /archive/:group so the
  // two-segment path never falls into the :group param) ----------------------
  app.get("/archive/att/:id", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const id = c.req.param("id");
    const att = await getAttachmentWithMessage(c.env.DB, id);
    if (!att) return c.text("not found", 404);
    const group = await getGroupById(c.env.DB, att.group_id);
    if (!group || group.tenant_id !== tenant.id) return c.text("not found", 404);
    if (!canViewGroup(viewer, group)) return c.text("not found", 404);

    const obj = await c.env.ATTACHMENTS.get(att.r2_key);
    if (!obj) return c.text("not found", 404);

    const headers = new Headers();
    headers.set("Content-Type", att.content_type || "application/octet-stream");
    const disposition = att.content_type.startsWith("image/") ? "inline" : "attachment";
    headers.set(
      "Content-Disposition",
      `${disposition}; filename="${att.filename.replace(/[\\"\r\n]/g, "_")}"`,
    );
    // Auth-gated: keep it out of shared caches. Attachments are immutable,
    // so a private browser cache is fine.
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(obj.body, { headers });
  }));

  // ---- thread list per group ----------------------------------------------
  app.get("/archive/:group", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const groupLocal = c.req.param("group").toLowerCase();
    if (!GROUP_NAME_RE.test(groupLocal)) return c.text("not found", 404);
    const group = await getGroupByLocalpart(c.env.DB, tenant.id, groupLocal);
    if (!group || !canViewGroup(viewer, group)) return c.text("not found", 404);

    const totalThreads = await countThreadsByGroup(c.env.DB, group.id);
    const totalPages = Math.max(1, Math.ceil(totalThreads / PAGE_SIZE));
    const page = clampPage(c.req.query("page"), totalPages);
    const threads = await listThreadsByGroup(c.env.DB, group.id, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });

    return c.html(renderThreadListPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      group,
      threads,
      page,
      totalPages,
    }));
  }));

  // ---- thread view (stable permalink) -------------------------------------
  app.get("/t/:threadId", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const threadId = c.req.param("threadId");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(threadId)) return c.text("not found", 404);

    const messages = await listMessagesByThread(c.env.DB, threadId);
    if (messages.length === 0) return c.text("not found", 404);
    const group = await getGroupById(c.env.DB, messages[0]!.group_id);
    if (!group || group.tenant_id !== tenant.id) return c.text("not found", 404);
    if (!canViewGroup(viewer, group)) return c.text("not found", 404);

    const allAtts = await listAttachmentsByThread(c.env.DB, threadId);
    const attsByMessage = new Map<string, Attachment[]>();
    for (const a of allAtts) {
      const list = attsByMessage.get(a.message_id) ?? [];
      list.push(a);
      attsByMessage.set(a.message_id, list);
    }

    const rendered: RenderedMessage[] = [];
    for (const m of messages) {
      const atts = attsByMessage.get(m.id) ?? [];
      rendered.push({
        message: m,
        bodyHtml: await renderBody(m.body_html, m.body_text, atts),
        attachments: atts,
      });
    }

    return c.html(renderThreadPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      group,
      threadId,
      subject: messages[0]!.subject,
      messages: rendered,
    }));
  }));

  // ---- 6-digit code verify (HTML form on the sign-in "sent" page) ---------
  app.post("/auth/verify-code", async (c, next) => {
    const host = c.req.header("Host") ?? "";
    const result = classifyHost(host, c.var.config);
    if (result.kind !== "tenant") return next();
    const tenant = await getTenantBySlug(c.env.DB, result.slug);
    if (!tenant || tenant.status !== "active") return c.text("not found", 404);

    const form = await c.req.formData();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const code = String(form.get("code") ?? "").replace(/\s/g, "");
    const returnTo = safeReturnTo(String(form.get("return_to") ?? ""));

    const invalid = (): Response => c.html(
      renderSignInSentPage(tenant, c.var.config.productName, email, {
        returnTo,
        error: "That code is invalid or expired. Check the digits or request a new link.",
      }),
      400,
    );
    if (!EMAIL_RE.test(email) || !SIX_DIGIT_RE.test(code)) return invalid();

    // Admin/moderator first (same precedence as /auth/request + /auth/verify).
    const admin = await consumeMagicLinkByCode(c.env.DB, tenant.id, email, code, Date.now());
    if (admin) {
      const cookieValue = await issueTenantSessionCookie(admin.id, tenant.id, c.env.ADMIN_API_JWT_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          Location: returnTo ?? "/admin/",
          "Set-Cookie": buildTenantSetCookie(cookieValue),
        },
      });
    }

    const memberEmail = await consumeMemberMagicLinkByCode(c.env.DB, tenant.id, email, code, Date.now());
    if (memberEmail) {
      const cookieValue = await issueMemberSessionCookie(memberEmail, tenant.id, c.env.ADMIN_API_JWT_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          Location: returnTo ?? "/archive",
          "Set-Cookie": buildMemberSetCookie(cookieValue),
        },
      });
    }
    return invalid();
  });
}

// ---- viewer resolution ------------------------------------------------------

async function withViewer(
  c: Ctx,
  next: () => Promise<void>,
  handler: (ctx: { tenant: Tenant; viewer: ArchiveViewer }) => Promise<Response>,
): Promise<Response | void> {
  const host = c.req.header("Host") ?? "";
  const result = classifyHost(host, c.var.config);
  if (result.kind !== "tenant") return next();

  const { tenant, admin } = await resolveTenantContext({
    db: c.env.DB,
    cookieHeader: c.req.header("Cookie"),
    tenantSlug: result.slug,
    secret: c.env.ADMIN_API_JWT_SECRET,
  });
  if (!tenant) return c.text("not found", 404);

  if (admin) {
    return handler({
      tenant,
      viewer: { kind: "admin", admin, label: admin.display_name ?? admin.email },
    });
  }

  const member = await resolveMemberContext({
    db: c.env.DB,
    cookieHeader: c.req.header("Cookie"),
    tenant,
    secret: c.env.ADMIN_API_JWT_SECRET,
  });
  if (member) {
    return handler({
      tenant,
      viewer: {
        kind: "member",
        email: member.email,
        groupIds: new Set(member.groupIds),
        label: member.email,
      },
    });
  }

  // Unauthenticated. Browsers get the shared sign-in page with a return_to;
  // everything else gets a plain 401.
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/html") && c.req.method === "GET") {
    const returnTo = new URL(c.req.url).pathname;
    return new Response(null, {
      status: 302,
      headers: { Location: `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` },
    });
  }
  return c.text("unauthorized", 401);
}

export function canViewGroup(viewer: ArchiveViewer, group: Group): boolean {
  if (group.archive_visibility === "none") return false;
  if (viewer.kind === "admin") return true;
  if (group.archive_visibility === "public") return true;
  return viewer.groupIds.has(group.id);
}

/** Only same-site path redirects — never absolute URLs (open-redirect guard). */
export function safeReturnTo(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || /[\r\n]/.test(raw)) return null;
  return raw.length <= 512 ? raw : null;
}

function clampPage(raw: string | undefined, totalPages: number): number {
  const n = Number.parseInt(raw ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, totalPages);
}

async function renderBody(
  bodyHtml: string | null,
  bodyText: string | null,
  attachments: Attachment[],
): Promise<string> {
  if (bodyHtml && bodyHtml.trim() !== "") {
    const cidMap = new Map<string, string>();
    for (const a of attachments) {
      if (a.content_id) cidMap.set(normalizeContentId(a.content_id), `/archive/att/${a.id}`);
    }
    return sanitizeEmailHtml(bodyHtml, cidMap);
  }
  if (bodyText && bodyText.trim() !== "") return renderPlainTextBody(bodyText);
  return `<p class="empty">(empty message)</p>`;
}
