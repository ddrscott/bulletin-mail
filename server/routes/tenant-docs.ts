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
 * Single-tenant mode: the apex IS the tenant and the operator still needs
 * the full docs at /docs, so the intercept disables itself entirely.
 *
 * Like /join, this is server-rendered HTML — link-shareable, no JS, fast on
 * a phone.
 */

import type { Hono, Context } from "hono";
import { classifyHost, type InstanceConfig } from "@bulletinmail/shared";
import { getTenantBySlug, type Tenant } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import { shellHtml } from "./tenant.js";

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
      return c.html(shellHtml(config, "Not found", `
        <h1>Not found</h1>
        <p>There's no active organization at this address.</p>
      `), 404);
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
  h2 { font-size: 1.15rem; margin: 2.25rem 0 0.5rem; }
  ol, ul { padding-left: 1.25rem; }
  li { margin: 0.35rem 0; }
  code { font-size: 0.9em; background: color-mix(in srgb, currentColor 8%, transparent); padding: 0.1em 0.35em; border-radius: 3px; }
  .quicklinks { border: 1px solid var(--line); border-radius: 4px; padding: 0.9rem 1rem; margin: 1.25rem 0 0; }
  .quicklinks ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.4rem; }
  a { color: inherit; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 2.25rem 0 1rem; }
`;

function docsPage(config: InstanceConfig, tenant: Tenant, host: string): string {
  const h = esc(host);
  const apex = esc(config.apexDomain);
  const name = esc(tenant.display_name);

  return shellHtml(config, `${tenant.display_name} — Mailing-list docs`, `
    <header>
      <p class="kicker">${name}</p>
      <h1>Mailing-list docs</h1>
      <p class="lede">How to run and use the mailing lists at <code>${h}</code>.</p>
    </header>

    <div class="quicklinks">
      <ul>
        <li>Admin console — <a href="https://${h}/admin"><code>https://${h}/admin</code></a></li>
        <li>Message archive — <a href="https://${h}/archive"><code>https://${h}/archive</code></a></li>
        <li>Home page &amp; wiki — <a href="https://${h}/"><code>https://${h}/</code></a></li>
      </ul>
    </div>

    <h2>Start a list</h2>
    <ol>
      <li>Go to <a href="https://${h}/admin"><code>https://${h}/admin</code></a> and sign in — enter your email, then the 6-digit code we send you. (You must be on the team; an existing admin can invite you.)</li>
      <li>Click <strong>New group</strong>. The list name becomes its email address: <code>announcements</code> → <code>announcements@${h}</code>.</li>
      <li>Pick who can post — members, anyone, moderated, or announce-only. You can change this later.</li>
    </ol>
    <p>The list address works immediately.</p>

    <h2>Add people</h2>
    <ul>
      <li><strong>One at a time:</strong> open the group's <strong>Members</strong> tab and add their email. They get a confirmation email first and receive no list mail until they accept.</li>
      <li><strong>A whole spreadsheet:</strong> use <strong>Bulk import</strong> on the same tab — paste addresses (one per line, or <code>Name &lt;email&gt;</code>), preview, then add all.</li>
      <li><strong>Let people join themselves:</strong> share <code>https://${h}/join/&lt;list-name&gt;</code> — the exact link is shown on the group's <strong>Pending</strong> tab. Requests wait there for your approval; approved people start receiving mail right away.</li>
    </ul>

    <h2>Invite helpers</h2>
    <p>Open <strong>Team</strong> in the admin console. <strong>Admins</strong> have full control; <strong>moderators</strong> can edit the wiki and approve subscribe requests. Invitees get a sign-in link by email.</p>

    <h2>Send a message</h2>
    <p>Email <code>&lt;list-name&gt;@${h}</code> from your subscribed address — that's it. It reaches every active member with proper threading. Whether replies go to the whole list or just the author is the list's reply-to setting.</p>

    <h2>For subscribers</h2>
    <ul>
      <li><strong>Join</strong> with a link from ${name}, like <code>https://${h}/join/&lt;list-name&gt;</code>.</li>
      <li><strong>Unsubscribe</strong> any time with the link in the footer of every message.</li>
      <li><strong>Catch up</strong> on past messages at <a href="https://${h}/archive"><code>https://${h}/archive</code></a> — sign in with your email and a 6-digit code.</li>
    </ul>

    <hr>
    <p class="small muted">Want more detail? The full admin guide is at <a href="https://${apex}/docs/how-to/tenant-admin/">${apex}/docs/how-to/tenant-admin/</a> and the archive guide at <a href="https://${apex}/docs/how-to/archive/">${apex}/docs/how-to/archive/</a>. Platform docs (self-hosting, operations) live at <a href="https://${apex}/docs/">${apex}/docs/</a>.</p>
  `, DOCS_CSS);
}
