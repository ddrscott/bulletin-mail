/**
 * Per-tenant wiki routes — mounted on every tenant subdomain
 * (<tenant>.<apex>/*). The set of routes is:
 *
 *   public:
 *     GET  /                      render the "index" wiki page
 *     GET  /wiki/:slug            render a page
 *     GET  /wiki/img/:key         serve an uploaded image from R2
 *
 *   auth (host-scoped, separate from app.<apex> admin session):
 *     GET  /auth/sign-in          email form
 *     POST /auth/request          { email } → send magic link
 *     GET  /auth/verify?token=    consume → set cookie → redirect /
 *     POST /auth/sign-out         clear cookie
 *
 *   editor (requires bm_tenant_session):
 *     GET  /wiki/:slug/edit       Toast UI editor
 *     POST /api/wiki/:slug        save (JSON body: { title, mdSource })
 *     GET  /api/wiki/:slug/versions
 *     POST /api/wiki/:slug/revert/:versionId
 *     POST /api/wiki/upload       multipart `image` field → R2 → returns URL
 *
 * All routes assume the request already passed classifyHost==='tenant'. The
 * caller (workers/web/src/routes/tenant.ts) gates on that.
 */

import type { Hono, Context } from "hono";
import { gravatarHash, newUlid, tryIndexWikiPage, type EmbeddingAi } from "@bulletinmail/shared";
import { getAdminById, getAdminsByEmail, type Admin, type Tenant } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import {
  buildTenantClearCookie,
  resolveTenantContext,
  sendTenantMagicLink,
} from "./tenant-auth.js";
import { buildMemberClearCookie, sendMemberMagicLink } from "../archive/member-auth.js";
import { safeReturnTo } from "../archive/routes.js";
import { formatSixDigitCode, generateSixDigitCode } from "../lib/magic-link.js";
import { compileMarkdown, slugify } from "./markdown.js";
import {
  renderEditorPage,
  renderSignInPage,
  renderSignInSentPage,
} from "./editor.js";
import type {
  ActivityRow,
  PageWithCurrentVersion,
  SavePageInput,
  UpdateVersionSummaryInput,
  VersionRow,
} from "./do.js";
import {
  computeUnifiedDiff,
  generateSummary,
  SUMMARY_FALLBACK,
  type AiBindingLike,
} from "./summary.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const IMG_KEY_RE = /^[a-z0-9]{8,}\.(?:png|jpg|jpeg|gif|webp|svg)$/i;

export type TenantWikiContext = { tenant: Tenant; admin: Admin | null };

export function mountWikiRoutes(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
): void {
  // ---- auth ----------------------------------------------------------------
  // One sign-in page for both roles: tenant admins/moderators (wiki editing,
  // admin SPA) and list members (archive browsing). /auth/request decides
  // which magic link to send based on which table the email matches.
  app.get("/auth/sign-in", (c) => withTenant(c, ({ tenant }) =>
    c.html(renderSignInPage({
      tenant,
      productName: c.var.config.productName,
      returnTo: safeReturnTo(c.req.query("return_to") ?? ""),
    })),
  ));

  app.post("/auth/request", async (c) => withTenant(c, async ({ tenant }) => {
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const returnTo = safeReturnTo(String(form.get("return_to") ?? ""));
    if (!email) {
      return c.html(renderSignInPage({
        tenant, productName: c.var.config.productName, returnTo,
        error: "Please enter your email.",
      }), 400);
    }
    const tenantHost = c.req.header("Host") ?? `${tenant.slug}.${c.var.config.apexDomain}`;
    // Admin/moderator first; if the email holds no admin row for this
    // tenant, fall through to the member (archive) magic link. Both senders
    // are silent no-ops on a miss, so an outsider learns nothing either way.
    const admins = await getAdminsByEmail(c.env.DB, email);
    const isAdmin = admins.some((a) => a.tenant_id === tenant.id);
    if (isAdmin) {
      c.executionCtx.waitUntil(sendTenantMagicLink({
        db: c.env.DB,
        email: c.env.EMAIL,
        config: c.var.config,
        tenant,
        tenantHost,
        email_: email,
      }));
    } else {
      const code = generateSixDigitCode();
      c.executionCtx.waitUntil(sendMemberMagicLink({
        db: c.env.DB,
        email: c.env.EMAIL,
        config: c.var.config,
        tenant,
        tenantHost,
        memberEmail: email,
        code,
        formattedCode: formatSixDigitCode(code),
        returnTo,
      }));
    }
    return c.html(renderSignInSentPage(tenant, c.var.config.productName, email, { returnTo }));
  }));

  // GET /auth/verify is host-dispatched in routes/admin/auth.ts (single
  // handler so both site and tenant verify go through one entry point).
  // POST /auth/verify-code (the sent page's form) lives in archive/routes.ts.

  app.post("/auth/sign-out", () => {
    // Clear BOTH session jars — a moderator who is also a subscriber may
    // hold a member session too, and "sign out" must mean signed out.
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", buildTenantClearCookie());
    headers.append("Set-Cookie", buildMemberClearCookie());
    return new Response(null, { status: 302, headers });
  });

  // ---- public reads --------------------------------------------------------
  app.get("/", (c) => withTenant(c, ({ tenant, admin }) => renderWikiPage(c, tenant, admin, "index")));
  app.get("/wiki/:slug", (c) => withTenant(c, ({ tenant, admin }) => {
    const slug = c.req.param("slug").toLowerCase();
    if (!SLUG_RE.test(slug)) return c.text("not found", 404);
    return renderWikiPage(c, tenant, admin, slug);
  }));

  app.get("/wiki/img/:key", async (c) => withTenant(c, async ({ tenant }) => {
    const key = c.req.param("key");
    if (!IMG_KEY_RE.test(key)) return c.text("not found", 404);
    const obj = await c.env.WIKI_R2.get(`wiki/${tenant.slug}/img/${key}`);
    if (!obj) return c.text("not found", 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(obj.body, { headers });
  }));

  // ---- editor + JSON API (require tenant session) --------------------------
  app.get("/wiki/:slug/edit", (c) => withTenantAdmin(c, async ({ tenant }) => {
    const slug = c.req.param("slug").toLowerCase();
    if (!SLUG_RE.test(slug)) return c.text("not found", 404);
    const stub = wikiStub(c, tenant);
    const page = await callDo<PageWithCurrentVersion | null>(stub, "getPage", { slug });
    const versions = page
      ? await callDo<VersionRow[]>(stub, "listVersions", { pageId: page.id })
      : [];
    return c.html(renderEditorPage({
      tenant, productName: c.var.config.productName, slug, page, versions,
    }));
  }));

  app.post("/api/wiki/:slug", (c) => withTenantAdmin(c, async ({ tenant, admin }) => {
    const slug = c.req.param("slug").toLowerCase();
    if (!SLUG_RE.test(slug)) return c.json({ error: "invalid_slug" }, 400);
    const body = await safeJson<{ title?: string; mdSource?: string; note?: string; visibility?: string }>(c.req.raw);
    const title = body?.title?.trim() || slug;
    const mdSource = typeof body?.mdSource === "string" ? body.mdSource : "";
    if (!mdSource) return c.json({ error: "empty_body" }, 400);
    const visibility = body?.visibility === "private" ? "private" : "public";

    const htmlCompiled = compileMarkdown(mdSource);
    const stub = wikiStub(c, tenant);
    const input: SavePageInput = {
      slug, title,
      mdSource, htmlCompiled,
      authorAdminId: admin.id,
      note: body?.note ?? null,
      visibility,
    };
    const saved = await callDo<{
      pageId: string;
      versionId: string;
      previousMdSource: string | null;
    }>(stub, "savePage", input);

    // Cache the compiled HTML to R2 — public reads now return immediately
    // without round-tripping the DO. Visibility is stored as metadata so the
    // read path can gate without going back to the DO.
    await writeR2Page(c, tenant.slug, slug, htmlCompiled, title, visibility);

    // Fire-and-forget AI summary. The diff + LLM call + DO write all happen
    // after the response is returned to the user — never blocks the save.
    // Failures inside the writer log but do not throw (see summary.ts).
    c.executionCtx.waitUntil(
      summarizeAndStore({
        ai: c.env.AI as AiBindingLike | undefined,
        stub,
        versionId: saved.versionId,
        prevMd: saved.previousMdSource ?? "",
        newMd: mdSource,
      }),
    );

    // Unified search: (re)index the page — upsert by stable id, so saves
    // overwrite the previous vector. No-op when search isn't enabled.
    c.executionCtx.waitUntil(
      tryIndexWikiPage(c.env.AI as unknown as EmbeddingAi | undefined, c.env.SEARCH_INDEX, {
        tenantId: tenant.id,
        slug,
        title,
        mdSource,
        visibility,
        updatedAt: Date.now(),
      }),
    );

    // Strip the previousMdSource from the wire response — clients never
    // need it and the source can be large.
    return c.json({ pageId: saved.pageId, versionId: saved.versionId }, 200);
  }));

  app.get("/api/wiki/:slug/versions", (c) => withTenantAdmin(c, async ({ tenant }) => {
    const slug = c.req.param("slug").toLowerCase();
    const stub = wikiStub(c, tenant);
    const page = await callDo<PageWithCurrentVersion | null>(stub, "getPage", { slug });
    if (!page) return c.json({ versions: [] });
    const versions = await callDo<VersionRow[]>(stub, "listVersions", { pageId: page.id });
    return c.json({ versions });
  }));

  app.post("/api/wiki/:slug/revert/:versionId", (c) => withTenantAdmin(c, async ({ tenant, admin }) => {
    const slug = c.req.param("slug").toLowerCase();
    const versionId = c.req.param("versionId");
    const stub = wikiStub(c, tenant);
    const page = await callDo<PageWithCurrentVersion | null>(stub, "getPage", { slug });
    if (!page) return c.json({ error: "not_found" }, 404);
    const ver = await callDo<VersionRow | null>(stub, "getVersion", { versionId });
    if (!ver || ver.page_id !== page.id) return c.json({ error: "not_found" }, 404);
    const out = await callDo<{ newVersionId: string } | null>(stub, "revertToVersion", {
      pageId: page.id, versionId, authorAdminId: admin.id,
    });
    if (!out) return c.json({ error: "revert_failed" }, 500);
    // Re-cache R2 with the reverted HTML.
    await writeR2Page(c, tenant.slug, slug, ver.html_compiled, page.title, page.visibility);
    // Search index follows the live content — reverting changes the page, so
    // re-embed the restored markdown (same stable vector id → overwrite).
    c.executionCtx.waitUntil(
      tryIndexWikiPage(c.env.AI as unknown as EmbeddingAi | undefined, c.env.SEARCH_INDEX, {
        tenantId: tenant.id,
        slug,
        title: page.title,
        mdSource: ver.md_source,
        visibility: page.visibility === "private" ? "private" : "public",
        updatedAt: Date.now(),
      }),
    );
    return c.json(out);
  }));

  // ---- activity feed (admin only) -----------------------------------------
  app.get("/activity", (c) => withTenantAdmin(c, async ({ tenant, admin }) => {
    const stub = wikiStub(c, tenant);
    const rows = await callDo<ActivityRow[]>(stub, "listRecentActivity", { limit: 100 });
    const authorById = await loadAuthorNameMap(c, rows);
    // Page-current md_source is only available via getPage(slug). For an
    // accurate per-row delta we'd need the previous version's md too — that's
    // expensive at list time. We use the stored summary as the headline and
    // skip a per-row delta (the AI text already carries the change shape;
    // and computing 100 diffs on render would defeat the point of the cache).
    return c.html(renderActivityPage({
      tenant,
      productName: c.var.config.productName,
      admin,
      rows,
      authorById,
    }));
  }));

  app.post("/api/wiki/upload", (c) => withTenantAdmin(c, async ({ tenant }) => {
    const form = await c.req.formData();
    const file = form.get("image") as unknown;
    if (!file || typeof file !== "object" || !("arrayBuffer" in file) || !("size" in file) || !("type" in file)) {
      return c.json({ error: "missing_file" }, 400);
    }
    const f = file as { arrayBuffer: () => Promise<ArrayBuffer>; size: number; type: string; name?: string };
    if (f.size > 5 * 1024 * 1024) return c.json({ error: "too_large" }, 413);

    const ext = pickExt(f.type, f.name ?? "");
    if (!ext) return c.json({ error: "unsupported_type" }, 415);

    const key = `${newUlid().toLowerCase()}.${ext}`;
    await c.env.WIKI_R2.put(`wiki/${tenant.slug}/img/${key}`, await f.arrayBuffer(), {
      httpMetadata: { contentType: f.type, cacheControl: "public, max-age=31536000, immutable" },
    });
    return c.json({ url: `/wiki/img/${key}` });
  }));
}

// ---- internals --------------------------------------------------------------

async function withTenant(
  c: Ctx,
  handler: (ctx: TenantWikiContext) => Response | Promise<Response>,
): Promise<Response> {
  const slug = currentTenantSlug(c);
  if (!slug) return c.text("not found", 404);
  const { tenant, admin } = await resolveTenantContext({
    db: c.env.DB,
    cookieHeader: c.req.header("Cookie"),
    tenantSlug: slug,
    secret: c.env.ADMIN_API_JWT_SECRET,
  });
  if (!tenant) return c.text("not found", 404);
  return handler({ tenant, admin });
}

async function withTenantAdmin(
  c: Ctx,
  handler: (ctx: { tenant: Tenant; admin: Admin }) => Response | Promise<Response>,
): Promise<Response> {
  const result = await withTenant(c, async ({ tenant, admin }) => {
    if (!admin) {
      // Browser flows: redirect to sign-in carrying a `return_to`. JSON callers
      // get 401.
      const accept = c.req.header("Accept") ?? "";
      if (accept.includes("text/html") && c.req.method === "GET") {
        const returnTo = new URL(c.req.url).pathname;
        return new Response(null, {
          status: 302,
          headers: { Location: `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` },
        });
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    return handler({ tenant, admin });
  });
  return result;
}

function currentTenantSlug(c: Ctx): string | null {
  // The host gate in tenant.ts already ran classifyHost; we re-derive the
  // slug from the Host header here so this module stays self-contained.
  const host = (c.req.header("Host") ?? "").toLowerCase();
  const apex = c.var.config.apexDomain.toLowerCase();
  if (!host.endsWith(`.${apex}`)) return null;
  const slug = host.slice(0, host.length - apex.length - 1);
  if (!slug || slug === "app" || slug === "www") return null;
  return slug;
}

function wikiStub(c: Ctx, tenant: Tenant): DurableObjectStub {
  const id = c.env.WIKI.idFromName(tenant.slug);
  return c.env.WIKI.get(id);
}

async function callDo<T>(stub: DurableObjectStub, method: string, payload: unknown): Promise<T> {
  const res = await stub.fetch(`https://do.local/rpc/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DO rpc ${method} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

async function renderWikiPage(
  c: Ctx,
  tenant: Tenant,
  admin: Admin | null,
  slug: string,
): Promise<Response> {
  // R2 fast path. Falls back to DO+compile when R2 is cold.
  const cacheKey = `wiki/${tenant.slug}/${slug}.html`;
  let cached = await c.env.WIKI_R2.get(cacheKey);
  let title = "";
  let body = "";
  let visibility: "public" | "private" = "public";

  if (cached) {
    const meta = await c.env.WIKI_R2.head(cacheKey);
    title = meta?.customMetadata?.title ?? slug;
    visibility = meta?.customMetadata?.visibility === "private" ? "private" : "public";
    body = await cached.text();
  } else {
    const stub = wikiStub(c, tenant);
    const page = await callDo<PageWithCurrentVersion | null>(stub, "getPage", { slug });
    if (page) {
      title = page.title;
      body = page.html_compiled;
      visibility = page.visibility === "private" ? "private" : "public";
      // Warm the cache for next read.
      await writeR2Page(c, tenant.slug, slug, body, title, visibility);
    }
  }

  // Visibility gate. Private pages require a tenant session (admin OR
  // moderator). Browsers hitting a private page unauthenticated land on the
  // sign-in form with a return_to back to this page; JSON/HEAD callers get
  // 401 plain.
  if (visibility === "private" && !admin) {
    const accept = c.req.header("Accept") ?? "";
    if (accept.includes("text/html")) {
      const returnTo = new URL(c.req.url).pathname;
      return new Response(null, {
        status: 302,
        headers: { Location: `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` },
      });
    }
    return c.text("unauthorized", 401);
  }

  const avatarUrl = admin ? await gravatarAvatarUrlFor(admin.email) : null;
  if (!body) {
    return c.html(renderEmptyPagePlaceholder(tenant, c.var.config.productName, slug, admin, avatarUrl), 200);
  }
  return c.html(renderWikiShell(tenant, c.var.config.productName, slug, title, body, admin, avatarUrl, visibility), 200);
}

async function gravatarAvatarUrlFor(email: string, size = 48): Promise<string> {
  const hash = await gravatarHash(email);
  return `https://gravatar.com/avatar/${hash}?d=identicon&s=${size * 2}`;
}

async function writeR2Page(
  c: Ctx,
  tenantSlug: string,
  slug: string,
  html: string,
  title: string,
  visibility: "public" | "private" = "public",
): Promise<void> {
  await c.env.WIKI_R2.put(`wiki/${tenantSlug}/${slug}.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { title, visibility },
  });
}

function renderWikiShell(
  tenant: Tenant,
  productName: string,
  slug: string,
  title: string,
  bodyHtml: string,
  admin: Admin | null,
  avatarUrl: string | null,
  visibility: "public" | "private" = "public",
): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  // Right-side masthead element. Editor gets the admin-SPA user menu;
  // visitors get a "Moderator sign-in" link. Lives in the masthead's right
  // grid column — parallel to the admin SPA's renderMasthead().
  const userMenuHtml = renderWikiUserMenu(admin, avatarUrl, tenant, slug, esc);

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(tenant.display_name)}</title>
<link rel="stylesheet" href="/admin/styles.css">
<style>
  .visibility-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--rule); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; }
  .visibility-badge--private { background: var(--paper-2); color: var(--alert); border-color: var(--alert); }
  main.wiki-main { max-width: var(--width-prose); margin: 0 auto; padding: var(--space-6) 0 var(--space-9); }
  main.wiki-main > h1:first-child { margin-top: 0; }
  main.wiki-main a.wiki-link { border-bottom: 1px dashed currentColor; text-decoration: none; }
  main.wiki-main a.wiki-link:hover { background: var(--paper-2); }
  main.wiki-main img { max-width: 100%; height: auto; }
  main.wiki-main .wiki-embed {
    margin: var(--space-6) 0; aspect-ratio: 16 / 9; width: 100%;
    background: var(--paper-2); border: var(--hairline);
  }
  main.wiki-main .wiki-embed[data-shape="fixed-height"] { aspect-ratio: auto; height: 400px; }
  main.wiki-main .wiki-embed iframe { display: block; width: 100%; height: 100%; border: 0; }
  main.wiki-main pre { background: var(--paper-2); padding: var(--space-3) var(--space-4); border: var(--hairline); overflow-x: auto; }
  main.wiki-main blockquote { border-left: 2px solid var(--ink); margin: var(--space-5) 0; padding: 0 0 0 var(--space-4); color: var(--ink-muted); font-family: var(--font-serif); font-style: italic; }
  main.wiki-main blockquote p { margin: 0; }
  .wiki-footer { margin-top: var(--space-7); padding: var(--space-5) 0; border-top: var(--hairline); font: var(--text-xs)/1.5 var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted); }
  .wiki-footer a { color: var(--ink-muted); }
  .wiki-footer a:hover { color: var(--ink); background: transparent; }
  /* Prominent Edit affordance for admins — sits next to 'Wiki' in the
   * dateline row, NOT buried in the avatar dropdown. */
  .dateline a.wiki-edit-link {
    color: var(--ink); font-weight: 700;
    border: 1px solid var(--ink); padding: 2px 10px; border-radius: 999px;
    text-decoration: none;
  }
  .dateline a.wiki-edit-link:hover { background: var(--ink); color: var(--paper); }
</style>
</head><body>
<div class="app-shell">
  <header class="masthead masthead--tenant">
    <h1 class="wordmark wordmark--with-kicker">
      <span class="wordmark__kicker">BulletinMail</span>
      <a href="/">${esc(tenant.display_name)}</a>
    </h1>
    ${userMenuHtml}
  </header>
  <div class="dateline dateline--row">
    <div class="dateline__nav">
      <a href="/">Wiki</a><span class="sep">·</span><a href="/archive">Archive</a>${visibility === "private" ? `<span class="sep">·</span><span class="visibility-badge visibility-badge--private" title="Only your team can view this page">Private</span>` : ""}${admin ? `<span class="sep">·</span><a href="/wiki/${esc(slug)}/edit" class="wiki-edit-link">Edit</a>` : ""}
    </div>
  </div>
  <main class="wiki-main">${bodyHtml}</main>
  <footer class="wiki-footer"><a href="/">Home</a> · Powered by ${esc(productName)}</footer>
</div>
</body></html>`;
}

/**
 * Render the wiki masthead's right-slot element: the moderator user menu
 * for signed-in editors, or a "Moderator sign-in" link for visitors.
 *
 * Parallels apps/admin/src/views/masthead.ts#renderUserMenu — both produce
 * the same `.user-menu` DOM structure. Kept duplicated because the wiki is
 * server-rendered HTML strings while the admin app builds DOM nodes at
 * runtime; the CSS in packages/shared/design/components.css is the shared
 * contract.
 */
function renderWikiUserMenu(
  admin: Admin | null,
  avatarUrl: string | null,
  tenant: Tenant,
  slug: string,
  esc: (s: string) => string,
): string {
  if (!admin || !avatarUrl) {
    return `<a class="masthead__right" href="/auth/sign-in">Moderator sign-in</a>`;
  }
  const triggerLabel = (admin.display_name ?? admin.email) || "Account";
  const roleLabel = admin.role === "admin" ? "Tenant admin" : "Moderator";
  return `<details class="user-menu">
  <summary class="user-menu__trigger" aria-label="${esc(triggerLabel)}">
    <img class="avatar" src="${esc(avatarUrl)}" alt="" width="24" height="24">
    <span class="user-menu__caret" aria-hidden="true">▾</span>
  </summary>
  <div class="user-menu__panel" role="menu">
    <div class="user-menu__meta">
      <strong>${esc(admin.display_name ?? admin.email)}</strong><br>
      ${esc(admin.email)}<br>
      ${esc(roleLabel)} · ${esc(tenant.display_name)}
    </div>
    <a class="user-menu__item" href="/admin/#/profile">Profile</a>
    <div class="user-menu__section">Manage</div>
    <a class="user-menu__item" href="/admin/">Admin home</a>
    <a class="user-menu__item" href="/activity">Wiki activity</a>
    <a class="user-menu__item" href="/wiki/${esc(slug)}/edit">Edit page</a>
    <form method="post" action="/auth/sign-out" style="margin:0">
      <button type="submit" class="user-menu__item user-menu__item--danger" style="text-align:left;width:100%">Sign out</button>
    </form>
  </div>
</details>`;
}

function renderEmptyPagePlaceholder(
  tenant: Tenant,
  productName: string,
  slug: string,
  admin: Admin | null,
  avatarUrl: string | null,
): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const editCta = admin
    ? `<p><a class="btn btn--primary" href="/wiki/${esc(slug)}/edit">Create this page →</a></p>`
    : `<p><a href="/auth/sign-in">Sign in as a moderator</a> to create this page.</p>`;
  return renderWikiShell(tenant, productName, slug, slug, `<h1>${esc(slug)}</h1><p class="muted">This page doesn't exist yet.</p>${editCta}`, admin, avatarUrl);
}

async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function pickExt(mime: string, name: string): string | null {
  const fromMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  const ext = fromMime[mime.toLowerCase()];
  if (ext) return ext;
  const m = /\.(png|jpe?g|gif|webp|svg)$/i.exec(name);
  return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : null;
}

// ---- activity feed --------------------------------------------------------

/**
 * Fire-and-forget worker that diffs old → new, hits Workers AI for a
 * summary, and writes it back to the version row via DO RPC. Never throws.
 * Designed to be called from `c.executionCtx.waitUntil(...)`.
 */
async function summarizeAndStore(opts: {
  ai: AiBindingLike | undefined;
  stub: DurableObjectStub;
  versionId: string;
  prevMd: string;
  newMd: string;
}): Promise<void> {
  try {
    const diff = computeUnifiedDiff(opts.prevMd, opts.newMd, 3);
    // Empty diff (identical content) — record the fallback so the activity
    // row isn't blank forever. The +0/-0 delta will tell the reader nothing
    // really changed.
    const summary = opts.ai
      ? await generateSummary(opts.ai, diff)
      : SUMMARY_FALLBACK;
    const payload: UpdateVersionSummaryInput = {
      versionId: opts.versionId,
      summary,
    };
    await callDo<{ updated: boolean }>(opts.stub, "updateVersionSummary", payload);
  } catch (err) {
    console.error("wiki summary writer failed", err);
  }
}

/**
 * Bulk-load the display names for every distinct author_admin_id referenced
 * by these activity rows. Falls back to "(deleted)" for rows whose author
 * row has been removed.
 */
async function loadAuthorNameMap(
  c: Ctx,
  rows: ActivityRow[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.author_admin_id);
  const out = new Map<string, string>();
  // Sequential D1 calls are fine — N is bounded by the activity row cap
  // (100) and in practice 1–5 distinct authors. Keeps the query layer
  // simple and avoids a one-off "list admins by ids" helper.
  await Promise.all(
    Array.from(ids).map(async (id) => {
      const a = await getAdminById(c.env.DB, id);
      out.set(id, a?.display_name ?? a?.email ?? "(deleted)");
    }),
  );
  return out;
}

type ActivityPageOpts = {
  tenant: Tenant;
  productName: string;
  admin: Admin;
  rows: ActivityRow[];
  authorById: Map<string, string>;
};

function renderActivityPage({ tenant, productName, admin, rows, authorById }: ActivityPageOpts): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const items = rows.length === 0
    ? `<li class="activity-empty muted">No edits yet. Save a page and the feed will populate here.</li>`
    : rows.map((r) => renderActivityRow(r, authorById, esc)).join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activity — ${esc(tenant.display_name)}</title>
<link rel="stylesheet" href="/admin/styles.css">
<style>
  main.activity-main { max-width: var(--width-prose); margin: 0 auto; padding: var(--space-6) 0 var(--space-9); }
  main.activity-main h1 { font-size: var(--text-2xl); margin: 0 0 var(--space-2); }
  main.activity-main p.lede { color: var(--ink-muted); margin: 0 0 var(--space-6); }
  ul.activity-feed { list-style: none; padding: 0; margin: 0; }
  ul.activity-feed > li.activity-row { padding: var(--space-4) 0; border-bottom: var(--hairline); }
  ul.activity-feed > li.activity-row:last-child { border-bottom: 0; }
  .activity-row__title { font: 600 var(--text-base) var(--font-sans); margin: 0 0 var(--space-1); }
  .activity-row__title a { text-decoration: none; border-bottom: 1px dashed currentColor; color: var(--ink); }
  .activity-row__title a:hover { background: var(--paper-2); }
  .activity-row__summary { margin: var(--space-1) 0; color: var(--ink); }
  .activity-row__summary.muted { color: var(--ink-muted); font-style: italic; }
  .activity-row__meta { font: var(--text-xs)/1.4 var(--font-mono); color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .activity-row__meta .sep { padding: 0 var(--space-2); }
  .activity-row__delta .delta { font-weight: 700; padding: 0 2px; }
  .activity-row__delta .delta--add { color: var(--ok, #166534); }
  .activity-row__delta .delta--del { color: var(--alert, #b91c1c); margin-left: 4px; }
  .activity-row__diff { margin-top: var(--space-2); }
  .activity-row__diff summary {
    cursor: pointer; font: 600 var(--text-xs) var(--font-mono);
    color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em;
    list-style: none;
  }
  .activity-row__diff summary::-webkit-details-marker { display: none; }
  .activity-row__diff summary:hover { color: var(--ink); }
  .activity-row__diff[open] summary { color: var(--ink); margin-bottom: var(--space-2); }
  .activity-row__diff pre {
    margin: 0; padding: var(--space-3) var(--space-4);
    background: var(--paper-2); border: var(--hairline); border-radius: 4px;
    overflow: auto; font: 12px/1.5 var(--font-mono); color: var(--ink);
    white-space: pre; max-height: 28rem;
  }
  .activity-row__diff pre .diff-add { color: #0a6b34; background: #e6f6ea; display: block; }
  .activity-row__diff pre .diff-del { color: #962020; background: #fbe8e8; display: block; }
  .activity-row__diff pre .diff-hunk { color: var(--ink-muted); display: block; }
  .activity-row__diff pre .diff-ctx { color: var(--ink); display: block; }
  .activity-empty { padding: var(--space-5) 0; }
</style>
</head><body>
<div class="app-shell">
  <header class="masthead masthead--tenant">
    <h1 class="wordmark wordmark--with-kicker">
      <span class="wordmark__kicker">BulletinMail</span>
      <a href="/">${esc(tenant.display_name)}</a>
    </h1>
    <a class="masthead__right" href="/admin/">Admin home</a>
  </header>
  <div class="dateline dateline--row">
    <div class="dateline__nav">
      <a href="/">Wiki</a><span class="sep">·</span><strong>Activity</strong>
    </div>
  </div>
  <main class="activity-main">
    <h1>Wiki activity</h1>
    <p class="lede">Recent edits across every page, newest first. Summaries are AI-generated from the diff — the timestamp and author are the source of truth.</p>
    <ul class="activity-feed">${items}</ul>
  </main>
  <footer class="wiki-footer"><a href="/">Home</a> · Powered by ${esc(productName)} · Signed in as ${esc(admin.display_name ?? admin.email)}</footer>
</div>
</body></html>`;
}

function renderActivityRow(
  r: ActivityRow,
  authorById: Map<string, string>,
  esc: (s: string) => string,
): string {
  const summary = (r.summary ?? "").trim();
  const summaryHtml = summary
    ? `<p class="activity-row__summary">${esc(summary)}</p>`
    : `<p class="activity-row__summary muted">${esc(SUMMARY_FALLBACK)}</p>`;
  const author = authorById.get(r.author_admin_id) ?? "(deleted)";
  const when = relativeTime(r.created_at);
  // Show the deterministic line delta next to the AI summary — per the task
  // constraint, the AI text never appears without a ground-truth signal.
  // Pre-feature rows have null deltas; render them as a plain "—".
  const deltaHtml = r.added_lines === null || r.removed_lines === null
    ? `<span class="activity-row__delta muted">—</span>`
    : `<span class="activity-row__delta"><span class="delta delta--add">+${r.added_lines}</span><span class="delta delta--del">-${r.removed_lines}</span></span>`;
  // Diff expander — collapsed by default, native <details> so no JS. Lines
  // are colored by their leading +/-/@ marker for readability. NULL on the
  // first-version-of-a-page and on rows older than this feature.
  const diffHtml = r.diff_unified
    ? `<details class="activity-row__diff"><summary>Show diff</summary><pre>${renderDiffLines(r.diff_unified, esc)}</pre></details>`
    : "";
  return `<li class="activity-row">
    <h2 class="activity-row__title"><a href="/wiki/${esc(r.page_slug)}">${esc(r.page_title)}</a> <span class="muted" style="font-weight:400">· /${esc(r.page_slug)}</span></h2>
    ${summaryHtml}
    <p class="activity-row__meta">
      ${deltaHtml}<span class="sep">·</span>${esc(author)}<span class="sep">·</span>${esc(when)}<span class="sep">·</span>v${esc(r.version_id.slice(0, 8))}
    </p>
    ${diffHtml}
  </li>`;
}

/**
 * Render a unified diff string as colored HTML — one `<span class="diff-…">`
 * per line so CSS can paint adds green / removes red / hunk headers muted.
 * Strips the `--- previous` / `+++ current` filename lines (they're noise in
 * a single-diff view; the hunk header `@@ … @@` is enough).
 */
function renderDiffLines(diff: string, esc: (s: string) => string): string {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    if (raw === "") continue;
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue; // strip filename rows
    let cls: string;
    if (raw.startsWith("@@")) cls = "diff-hunk";
    else if (raw.startsWith("+")) cls = "diff-add";
    else if (raw.startsWith("-")) cls = "diff-del";
    else cls = "diff-ctx";
    out.push(`<span class="${cls}">${esc(raw)}</span>`);
  }
  return out.join("\n");
}

/** Coarse human-readable relative time. Avoids a date-fns dep on the Worker. */
function relativeTime(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(days / 365);
  return `${years}y ago`;
}

export { slugify };
