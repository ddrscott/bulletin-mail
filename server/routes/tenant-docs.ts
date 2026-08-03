/**
 * Tenant-facing docs — <tenant>.<apex>/docs.
 *
 * The ASSETS fallthrough serves the full Starlight docs tree on every host,
 * but that tree is written for operators (DNS, wrangler, day-2 ops). A tenant
 * admin looking for "how do I add people" shouldn't wade through it — so
 * tenant subdomains get one server-rendered getting-started page with the
 * tenant's real URLs filled in. Deep /docs/* links on tenant hosts 301 to
 * the canonical apex docs.
 *
 * Rendered in the shared archive/wiki shell so the page reads as part of the
 * tenant site (masthead, dateline, /admin/styles.css tokens), not a separate
 * product.
 *
 * Single-tenant mode: the apex IS the tenant and the operator still needs
 * the full docs at /docs, so the intercept disables itself entirely.
 */

import type { Hono, Context } from "hono";
import { classifyHost, type InstanceConfig } from "@bulletinmail/shared";
import { getTenantBySlug, type Tenant } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import { shell } from "../archive/render.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export function mountTenantDocs(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  const handler = async (c: Ctx, next: () => Promise<void>) => {
    const config = c.var.config;
    // Single-tenant instances keep the full docs tree on /docs.
    if (config.features.singleTenant) return next();
    const host = c.req.header("Host") ?? "";
    const result = classifyHost(host, config);
    if (result.kind !== "tenant") return next();

    const url = new URL(c.req.url);
    if (url.pathname !== "/docs" && url.pathname !== "/docs/") {
      // Deep docs links keep working, but canonically on the apex.
      return c.redirect(`https://${config.apexDomain}${url.pathname}${url.search}`, 301);
    }

    const tenant = await getTenantBySlug(c.env.DB, result.slug);
    if (!tenant || tenant.status !== "active") {
      return c.text("Not found", 404);
    }
    return c.html(docsPage(config, tenant, host), 200);
  };

  app.get("/docs", handler);
  app.get("/docs/*", handler);
}

// ---- HTML rendering ---------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const DOCS_CSS = `
  main.archive-main h2 { font: 600 var(--text-base) var(--font-sans); margin: var(--space-7) 0 var(--space-2); text-transform: uppercase; letter-spacing: 0.05em; font-size: var(--text-sm); }
  main.archive-main ol, main.archive-main ul { margin: 0; padding-left: 1.25rem; }
  main.archive-main li { margin: var(--space-2) 0; }
  main.archive-main code { font-family: var(--font-mono); font-size: 0.85em; }
  main.archive-main a code { color: inherit; }
  ul.quicklinks { list-style: none; padding: 0; margin: 0 0 var(--space-2); border-top: var(--hairline); }
  ul.quicklinks li { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: baseline; padding: var(--space-3) 0; margin: 0; border-bottom: var(--hairline); }
  ul.quicklinks .ql-label { font: var(--text-xs)/1.4 var(--font-mono); color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; min-width: 9rem; }
  .docs-note { font-size: var(--text-sm); color: var(--ink-muted); margin: var(--space-2) 0 0; }
`;

function docsPage(config: InstanceConfig, tenant: Tenant, host: string): string {
  const h = esc(host);
  const apex = esc(config.apexDomain);
  const name = esc(tenant.display_name);

  const body = `
    <h1>Docs</h1>
    <p class="lede">How to run and use the mailing lists at ${name}.</p>

    <ul class="quicklinks">
      <li><span class="ql-label">Admin console</span> <a href="https://${h}/admin"><code>${h}/admin</code></a></li>
      <li><span class="ql-label">Message archive</span> <a href="https://${h}/archive"><code>${h}/archive</code></a></li>
      <li><span class="ql-label">Home &amp; wiki</span> <a href="https://${h}/"><code>${h}/</code></a></li>
    </ul>

    <h2>Start a list</h2>
    <ol>
      <li>Open the <a href="https://${h}/admin">admin console</a> and sign in — enter your email, then the 6-digit code we send you. (You must be on the team; an existing admin can invite you.)</li>
      <li>Click <strong>New group</strong>. The list name becomes its email address: <code>announcements</code> → <code>announcements@${h}</code>.</li>
      <li>Pick who can post — members, anyone, moderated, or announce-only. You can change this later.</li>
    </ol>
    <p class="docs-note">The list address works immediately.</p>

    <h2>Add people</h2>
    <ul>
      <li><strong>One at a time</strong> — open the group's <strong>Members</strong> tab and add their email. They get a confirmation email first and receive no list mail until they accept.</li>
      <li><strong>A whole spreadsheet</strong> — use <strong>Bulk import</strong> on the same tab: paste addresses (one per line, or <code>Name &lt;email&gt;</code>), preview, then add all.</li>
      <li><strong>Let people join themselves</strong> — share <code>https://${h}/join/&lt;list-name&gt;</code>; the exact link is shown on the group's <strong>Pending</strong> tab. Requests wait there for your approval; approved people start receiving mail right away.</li>
    </ul>

    <h2>Invite helpers</h2>
    <p>Open <strong>Team</strong> in the admin console. <strong>Admins</strong> have full control; <strong>moderators</strong> can edit the wiki and approve subscribe requests. Invitees get a sign-in link by email.</p>

    <h2>Send a message</h2>
    <p>Email <code>&lt;list-name&gt;@${h}</code> from your subscribed address — that's it. It reaches every active member with proper threading. Whether replies go to the whole list or just the author is the list's reply-to setting.</p>

    <h2>For subscribers</h2>
    <ul>
      <li><strong>Join</strong> with a link from ${name}, like <code>https://${h}/join/&lt;list-name&gt;</code>.</li>
      <li><strong>Unsubscribe</strong> any time with the link in the footer of every message.</li>
      <li><strong>Catch up</strong> on past messages in the <a href="https://${h}/archive">archive</a> — sign in with your email and a 6-digit code.</li>
    </ul>

    <p class="docs-note">Want more detail? See the full <a href="https://${apex}/docs/how-to/tenant-admin/">admin guide</a> and <a href="https://${apex}/docs/how-to/archive/">archive guide</a>. Platform documentation lives at <a href="https://${apex}/docs/">${apex}/docs</a>.</p>
  `;

  return shell({
    tenant,
    productName: config.productName,
    title: "Docs",
    crumbs: [{ label: "Docs" }],
    viewerLabel: null,
    body,
    extraCss: DOCS_CSS,
  });
}
