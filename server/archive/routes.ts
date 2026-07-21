/**
 * Archive browser — read-only web view of list threads, served on the
 * tenant subdomain (<tenant>.<apex>; in single-tenant mode the apex itself
 * classifies as the tenant, so the same routes fire there unchanged).
 *
 *   GET  /archive               group (list) index the viewer may browse
 *   GET  /archive/:group        thread list, newest activity first, paginated
 *   GET  /t/:threadId           thread permalink — messages in thread order
 *   GET  /archive/att/:id       attachment download (auth-checked, R2)
 *   POST /archive/:group/new    start a new thread from the web (see post.ts)
 *   POST /t/:threadId/reply     reply to a thread from the web (see post.ts)
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
import {
  buildMessageVectors,
  classifyHost,
  searchTenant,
  tryIndexMessage,
  tryIndexWikiPage,
  type EmbeddingAi,
  type SearchMatch,
} from "@bulletinmail/shared";
import {
  appendAudit,
  consumeMagicLinkByCode,
  consumeMemberMagicLinkByCode,
  countRecentMessagesFromSender,
  countThreadsByGroup,
  getAttachmentWithMessage,
  getGroupById,
  getGroupByLocalpart,
  getMemberByEmail,
  getMessageById,
  getTenantBySlug,
  insertMessage,
  listAttachmentsByThread,
  listGroupsByTenant,
  listMessagesByThread,
  listMessagesForSearchBackfill,
  listThreadsByGroup,
  type Admin,
  type Attachment,
  type Group,
  type Message,
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
  type PostFormState,
  type RenderedMessage,
} from "./render.js";
import { renderSearchPage, wikiMatchToItem, type SearchResultItem } from "./search.js";
import {
  fanOutWebPost,
  normalizeBody,
  POST_RATE_LIMIT,
  postPermissionFor,
  replySubjectFor,
  validateNewThreadInput,
  validateReplyInput,
} from "./post.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { renderSignInSentPage } from "../wiki/editor.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const PAGE_SIZE = 50;
const GROUP_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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
      searchEnabled: searchBindings(c) !== null,
    }));
  }));

  // ---- unified search (archive + wiki, Vectorize) --------------------------
  // Hidden entirely (404) when the instance hasn't enabled search — the
  // binding presence IS the feature flag.
  app.get("/search", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const bindings = searchBindings(c);
    if (!bindings) return c.text("not found", 404);
    const query = (c.req.query("q") ?? "").slice(0, 200);

    let items: SearchResultItem[] | null = [];
    if (query.trim() !== "") {
      try {
        const matches = await searchTenant(bindings.ai, bindings.index, tenant.id, query, 20);
        items = await resolveSearchMatches(c, tenant, viewer, matches);
      } catch (err) {
        console.error("search: query failed", err);
        items = null;
      }
    }
    return c.html(renderSearchPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      query,
      items,
    }));
  }));

  // ---- search backfill (tenant admin) --------------------------------------
  // Indexes pre-existing content in slices so a single call stays inside
  // Worker subrequest limits. Call repeatedly until nextCursor is null:
  //   curl -X POST -b "<admin cookie>" https://<tenant-host>/api/search/backfill
  //   curl -X POST ... "https://<tenant-host>/api/search/backfill?cursor=<nextCursor>"
  // Wiki pages are (re)indexed on the first slice only; messages walk the
  // archive oldest-first by ulid keyset.
  app.post("/api/search/backfill", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    if (viewer.kind !== "admin") return c.json({ error: "forbidden" }, 403);
    const bindings = searchBindings(c);
    if (!bindings) return c.json({ error: "search_not_enabled" }, 404);

    const cursor = c.req.query("cursor") ?? "";
    const BATCH = 50;

    const rows = await listMessagesForSearchBackfill(c.env.DB, tenant.id, cursor, BATCH);
    let indexedMessages = 0;
    if (rows.length > 0) {
      const vectors = await buildMessageVectors(
        bindings.ai,
        rows.map((r) => ({
          messageId: r.id,
          tenantId: tenant.id,
          groupId: r.group_id,
          threadId: r.thread_id,
          subject: r.subject,
          bodyText: r.body_text,
          receivedAt: r.received_at,
        })),
      );
      await bindings.index.upsert(vectors);
      indexedMessages = vectors.length;
    }

    // Wiki pages only on the first slice — small-org wikis are a handful of
    // pages, and upserts by stable id are idempotent anyway.
    let indexedPages = 0;
    if (cursor === "") {
      try {
        const stub = c.env.WIKI.get(c.env.WIKI.idFromName(tenant.slug));
        const pages = await backfillDoRpc<Array<{ slug: string }>>(stub, "listPages", {});
        for (const p of pages) {
          const page = await backfillDoRpc<{
            slug: string;
            title: string;
            md_source: string;
            visibility: "public" | "private";
            updated_at: number;
          } | null>(stub, "getPage", { slug: p.slug });
          if (!page) continue;
          await tryIndexWikiPage(bindings.ai, bindings.index, {
            tenantId: tenant.id,
            slug: page.slug,
            title: page.title,
            mdSource: page.md_source,
            visibility: page.visibility === "private" ? "private" : "public",
            updatedAt: page.updated_at,
          });
          indexedPages++;
        }
      } catch (err) {
        console.error("search: wiki backfill failed", err);
      }
    }

    return c.json({
      indexedMessages,
      indexedPages,
      nextCursor: rows.length === BATCH ? rows[rows.length - 1]!.id : null,
    });
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
  app.get("/archive/:group", (c, next) => withViewer(c, next, ({ tenant, viewer }) =>
    showThreadList(c, tenant, viewer, c.req.param("group").toLowerCase(), {
      posted: c.req.query("posted") === "1",
    })));

  // ---- start a new thread from the web ------------------------------------
  app.post("/archive/:group/new", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const groupLocal = c.req.param("group").toLowerCase();
    if (!GROUP_NAME_RE.test(groupLocal)) return c.text("not found", 404);
    const group = await getGroupByLocalpart(c.env.DB, tenant.id, groupLocal);
    if (!group || !canViewGroup(viewer, group)) return c.text("not found", 404);

    const form = await c.req.formData();
    const subject = String(form.get("subject") ?? "").trim();
    const body = normalizeBody(String(form.get("body") ?? ""));
    const turnstileToken = String(form.get("cf-turnstile-response") ?? "") || undefined;

    const outcome = await acceptWebPost(c, {
      tenant,
      viewer,
      group,
      subject: subject || "(no subject)",
      body,
      parent: null,
      turnstileToken,
      inputErrors: validateNewThreadInput(subject, body),
    });
    // New thread: the message id IS the thread id (PRD §9.2 rule) — land on
    // the fresh permalink.
    if (outcome.ok) return c.redirect(`/t/${outcome.messageId}?posted=1`, 303);
    return showThreadList(c, tenant, viewer, groupLocal, {
      errors: outcome.errors,
      draftSubject: subject,
      draftBody: body,
      status: outcome.status,
    });
  }));

  // ---- thread view (stable permalink) -------------------------------------
  app.get("/t/:threadId", (c, next) => withViewer(c, next, ({ tenant, viewer }) =>
    showThread(c, tenant, viewer, c.req.param("threadId"), {
      posted: c.req.query("posted") === "1",
    })));

  // ---- reply to a thread from the web -------------------------------------
  app.post("/t/:threadId/reply", (c, next) => withViewer(c, next, async ({ tenant, viewer }) => {
    const threadId = c.req.param("threadId");
    if (!THREAD_ID_RE.test(threadId)) return c.text("not found", 404);
    const messages = await listMessagesByThread(c.env.DB, threadId);
    if (messages.length === 0) return c.text("not found", 404);
    const group = await getGroupById(c.env.DB, messages[0]!.group_id);
    if (!group || group.tenant_id !== tenant.id) return c.text("not found", 404);
    if (!canViewGroup(viewer, group)) return c.text("not found", 404);

    const form = await c.req.formData();
    const body = normalizeBody(String(form.get("body") ?? ""));
    const turnstileToken = String(form.get("cf-turnstile-response") ?? "") || undefined;

    const outcome = await acceptWebPost(c, {
      tenant,
      viewer,
      group,
      // Same subject a mail client would send on "Reply" — normalizeSubject
      // in the outbound builder handles prefix/marker cleanup identically to
      // a mailed reply.
      subject: replySubjectFor(messages[0]!.subject),
      body,
      // Reply to the thread as displayed: parent = the latest message, so the
      // References chain walks back through the whole conversation.
      parent: messages[messages.length - 1]!,
      turnstileToken,
      inputErrors: validateReplyInput(body),
    });
    if (outcome.ok) return c.redirect(`/t/${threadId}?posted=1#m-${outcome.messageId}`, 303);
    return showThread(c, tenant, viewer, threadId, {
      errors: outcome.errors,
      draftBody: body,
      status: outcome.status,
    });
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

// ---- search helpers ---------------------------------------------------------

/** Both bindings present → search is enabled for this instance. */
function searchBindings(c: Ctx): { ai: EmbeddingAi; index: NonNullable<Env["SEARCH_INDEX"]> } | null {
  const ai = c.env.AI as unknown as EmbeddingAi | undefined;
  const index = c.env.SEARCH_INDEX;
  if (!ai || !index) return null;
  return { ai, index };
}

/**
 * Turn raw tenant-scoped Vectorize matches into viewer-visible result rows.
 * Message hits are re-read from D1 and pass the same canViewGroup gate the
 * archive uses; wiki hits render from metadata (private pages admin-only).
 * Order (best score first) is preserved.
 */
async function resolveSearchMatches(
  c: Ctx,
  tenant: Tenant,
  viewer: ArchiveViewer,
  matches: SearchMatch[],
): Promise<SearchResultItem[]> {
  const groupById = new Map<string, Group>();
  for (const g of await listGroupsByTenant(c.env.DB, tenant.id)) groupById.set(g.id, g);

  const items: SearchResultItem[] = [];
  for (const match of matches) {
    if (match.id.startsWith("wiki:")) {
      const item = wikiMatchToItem(match, viewer.kind === "admin");
      if (item) items.push(item);
      continue;
    }
    if (!match.id.startsWith("msg:")) continue;
    const message = await getMessageById(c.env.DB, match.id.slice("msg:".length));
    if (!message) continue;
    const group = groupById.get(message.group_id);
    if (!group || group.tenant_id !== tenant.id) continue;
    if (!canViewGroup(viewer, group)) continue;
    items.push({
      kind: "message",
      title: message.subject || "(no subject)",
      snippet: typeof match.metadata?.snippet === "string" ? match.metadata.snippet : "",
      href: `/t/${message.thread_id}#m-${message.id}`,
      score: match.score,
      context: group.display_name,
      when: message.received_at,
    });
  }
  return items;
}

/** Minimal DO JSON-RPC call for the wiki backfill (same wire shape as
 *  server/wiki/routes.ts#callDo — duplicated to avoid a cross-module export
 *  of wiki internals). */
async function backfillDoRpc<T>(
  stub: DurableObjectStub,
  method: string,
  payload: unknown,
): Promise<T> {
  const res = await stub.fetch(`https://do.local/rpc/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`DO rpc ${method} failed (${res.status})`);
  return (await res.json()) as T;
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

// ---- pages (shared between GET and failed-POST re-render) -------------------

type ThreadListFormOpts = {
  posted?: boolean;
  errors?: string[];
  draftSubject?: string;
  draftBody?: string;
  status?: 400 | 403 | 429;
};

async function showThreadList(
  c: Ctx,
  tenant: Tenant,
  viewer: ArchiveViewer,
  groupLocal: string,
  formOpts: ThreadListFormOpts = {},
): Promise<Response> {
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

  return c.html(
    renderThreadListPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      group,
      threads,
      page,
      totalPages,
      newThreadForm: await postFormStateFor(c, group, viewer, formOpts),
    }),
    formOpts.status ?? 200,
  );
}

type ThreadFormOpts = {
  posted?: boolean;
  errors?: string[];
  draftBody?: string;
  status?: 400 | 403 | 429;
};

async function showThread(
  c: Ctx,
  tenant: Tenant,
  viewer: ArchiveViewer,
  threadId: string,
  formOpts: ThreadFormOpts = {},
): Promise<Response> {
  if (!THREAD_ID_RE.test(threadId)) return c.text("not found", 404);

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

  return c.html(
    renderThreadPage({
      tenant,
      productName: c.var.config.productName,
      viewerLabel: viewer.label,
      group,
      threadId,
      subject: messages[0]!.subject,
      messages: rendered,
      replyForm: await postFormStateFor(c, group, viewer, formOpts),
    }),
    formOpts.status ?? 200,
  );
}

// ---- web posting ------------------------------------------------------------

/**
 * Form state for the viewer on this group, or null when they may not post
 * (form hidden — the email path would bounce them at the SMTP boundary, the
 * web path simply doesn't offer the box).
 */
async function postFormStateFor(
  c: Ctx,
  group: Group,
  viewer: ArchiveViewer,
  opts: { posted?: boolean; errors?: string[]; draftSubject?: string; draftBody?: string },
): Promise<PostFormState | null> {
  const posterEmail = viewer.kind === "admin" ? viewer.admin.email : viewer.email;
  const membership = await getMemberByEmail(c.env.DB, group.id, posterEmail);
  const perm = postPermissionFor(group, membership);
  if (!perm.ok) return null;
  const siteKey = typeof c.env.TURNSTILE_SITE_KEY === "string" && c.env.TURNSTILE_SITE_KEY
    ? c.env.TURNSTILE_SITE_KEY
    : null;
  return {
    turnstileSiteKey: siteKey,
    posted: opts.posted,
    errors: opts.errors,
    draftSubject: opts.draftSubject,
    draftBody: opts.draftBody,
  };
}

type AcceptWebPostArgs = {
  tenant: Tenant;
  viewer: ArchiveViewer;
  group: Group;
  subject: string;
  body: string;
  /** Reply → the message being replied to; new thread → null. */
  parent: Message | null;
  turnstileToken: string | undefined;
  inputErrors: string[];
};

type AcceptWebPostOutcome =
  | { ok: true; messageId: string }
  | { ok: false; errors: string[]; status: 400 | 403 | 429 };

/**
 * Validate and ingest a web post. On success the message row exists (visible
 * in the archive immediately) and delivery fan-out is scheduled via
 * waitUntil — the same pipeline shape as an emailed post (see post.ts).
 */
async function acceptWebPost(c: Ctx, args: AcceptWebPostArgs): Promise<AcceptWebPostOutcome> {
  const posterEmail = args.viewer.kind === "admin" ? args.viewer.admin.email : args.viewer.email;

  // Posting policy — identical rules (and reason strings) to the inbound
  // Worker's envelope-sender validation.
  const membership = await getMemberByEmail(c.env.DB, args.group.id, posterEmail);
  const perm = postPermissionFor(args.group, membership);
  if (!perm.ok) return { ok: false, errors: [perm.reason], status: 403 };

  // Human check — env-gated exactly like admin sign-in (bypass when the
  // Turnstile secret isn't configured; fail closed when it is).
  const humanOk = await verifyTurnstile(
    typeof c.env.TURNSTILE_SECRET_KEY === "string" ? c.env.TURNSTILE_SECRET_KEY : undefined,
    args.turnstileToken,
    c.req.header("CF-Connecting-IP"),
  );
  if (!humanOk) {
    return {
      ok: false,
      errors: ["Human verification failed. Reload the page and try again."],
      status: 403,
    };
  }

  if (args.inputErrors.length > 0) return { ok: false, errors: args.inputErrors, status: 400 };

  // Per-member rate limit — counts every message this human put into the
  // tenant's lists recently, regardless of ingest path.
  const recent = await countRecentMessagesFromSender(
    c.env.DB,
    args.tenant.id,
    posterEmail,
    Date.now() - POST_RATE_LIMIT.windowMs,
  );
  if (recent >= POST_RATE_LIMIT.max) {
    return {
      ok: false,
      errors: ["You are posting too quickly. Wait a few minutes and try again."],
      status: 429,
    };
  }

  const fromName =
    perm.member?.display_name?.trim() ||
    (args.viewer.kind === "admin" ? args.viewer.admin.display_name : null) ||
    null;

  // Same row an emailed post gets from workers/inbound — original_message_id
  // stays null (there is no sender Message-ID; emailed replies to this post
  // thread back via deliveries.provider_message_id, resolveParent path 3).
  const messageId = await insertMessage(c.env.DB, {
    groupId: args.group.id,
    originalMessageId: null,
    inReplyToOutbound: args.parent?.id ?? null,
    threadId: args.parent?.thread_id ?? null,
    fromEmail: posterEmail,
    fromName,
    subject: args.subject,
    bodyText: args.body,
    bodyHtml: null,
    hasAttachments: false,
    status: "received",
    receivedAt: Date.now(),
  });

  await appendAudit(c.env.DB, {
    tenantId: args.tenant.id,
    actor: `web:${posterEmail}`,
    action: "webpost.accepted",
    details: {
      messageId,
      group: args.group.name,
      threadParent: args.parent?.id ?? null,
    },
  });

  c.executionCtx.waitUntil(
    fanOutWebPost({
      db: c.env.DB,
      email: c.env.EMAIL,
      config: c.var.config,
      tenant: args.tenant,
      group: args.group,
      messageId,
    }),
  );

  // Unified search: index the web post exactly like an emailed one. No-op
  // when the instance hasn't enabled search; failures never surface.
  c.executionCtx.waitUntil(
    tryIndexMessage(c.env.AI as unknown as EmbeddingAi | undefined, c.env.SEARCH_INDEX, {
      messageId,
      tenantId: args.tenant.id,
      groupId: args.group.id,
      threadId: args.parent?.thread_id ?? messageId,
      subject: args.subject,
      bodyText: args.body,
      receivedAt: Date.now(),
    }),
  );

  return { ok: true, messageId };
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
