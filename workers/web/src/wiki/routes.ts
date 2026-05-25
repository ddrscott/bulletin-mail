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
import { gravatarHash, newUlid } from "@bulletinmail/shared";
import type { Admin, Tenant } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import {
  buildTenantClearCookie,
  resolveTenantContext,
  sendTenantMagicLink,
} from "./tenant-auth.js";
import { compileMarkdown, slugify } from "./markdown.js";
import {
  renderEditorPage,
  renderSignInPage,
  renderSignInSentPage,
} from "./editor.js";
import type {
  PageWithCurrentVersion,
  SavePageInput,
  VersionRow,
} from "./do.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const IMG_KEY_RE = /^[a-z0-9]{8,}\.(?:png|jpg|jpeg|gif|webp|svg)$/i;

export type TenantWikiContext = { tenant: Tenant; admin: Admin | null };

export function mountWikiRoutes(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
): void {
  // ---- auth ----------------------------------------------------------------
  app.get("/auth/sign-in", (c) => withTenant(c, ({ tenant }) =>
    c.html(renderSignInPage({ tenant, productName: c.var.config.productName })),
  ));

  app.post("/auth/request", async (c) => withTenant(c, async ({ tenant }) => {
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!email) {
      return c.html(renderSignInPage({
        tenant, productName: c.var.config.productName, error: "Please enter your email.",
      }), 400);
    }
    c.executionCtx.waitUntil(sendTenantMagicLink({
      db: c.env.DB,
      email: c.env.EMAIL,
      config: c.var.config,
      tenant,
      tenantHost: c.req.header("Host") ?? `${tenant.slug}.${c.var.config.apexDomain}`,
      email_: email,
    }));
    return c.html(renderSignInSentPage(tenant, c.var.config.productName, email));
  }));

  // GET /auth/verify is host-dispatched in routes/admin/auth.ts (single
  // handler so both site and tenant verify go through one entry point).

  app.post("/auth/sign-out", () =>
    new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": buildTenantClearCookie() } }),
  );

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
    const saved = await callDo<{ pageId: string; versionId: string }>(stub, "savePage", input);

    // Cache the compiled HTML to R2 — public reads now return immediately
    // without round-tripping the DO. Visibility is stored as metadata so the
    // read path can gate without going back to the DO.
    await writeR2Page(c, tenant.slug, slug, htmlCompiled, title, visibility);
    return c.json(saved, 200);
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
    return c.json(out);
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
  const isEditor = admin !== null;

  // Right-side dateline cell. Editor gets the admin-SPA user menu; visitors
  // get a "Moderator sign-in" link.
  let rightCell: string;
  if (admin && avatarUrl) {
    const triggerLabel = (admin.display_name ?? admin.email) || "Account";
    const roleLabel = admin.role === "admin" ? "Tenant admin" : "Moderator";
    rightCell = `<details class="user-menu">
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
    <a class="user-menu__item" href="/wiki/${esc(slug)}/edit">Edit page</a>
    <form method="post" action="/auth/sign-out" style="margin:0">
      <button type="submit" class="user-menu__item user-menu__item--danger" style="text-align:left;width:100%">Sign out</button>
    </form>
  </div>
</details>`;
  } else {
    rightCell = `<a href="/auth/sign-in">Moderator sign-in</a>`;
  }
  void isEditor; // edit link now lives in the user menu, not the dateline

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
</style>
</head><body>
<div class="app-shell">
  <header class="masthead masthead--tenant">
    <h1 class="wordmark wordmark--with-kicker">
      <span class="wordmark__kicker">Bulletinmail</span>
      <a href="/">${esc(tenant.display_name)}</a>
    </h1>
  </header>
  <div class="dateline dateline--row">
    <div class="dateline__nav">
      <a href="/">Wiki</a>${visibility === "private" ? `<span class="sep">·</span><span class="visibility-badge visibility-badge--private" title="Only your team can view this page">Private</span>` : ""}
    </div>
    ${rightCell}
  </div>
  <main class="wiki-main">${bodyHtml}</main>
  <footer class="wiki-footer"><a href="/">Home</a> · Powered by ${esc(productName)}</footer>
</div>
</body></html>`;
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

export { slugify };
