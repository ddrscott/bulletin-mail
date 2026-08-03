/**
 * Per-tenant subdomain routes — <tenant>.<apex>/*.
 *
 *   GET  /join/<group>         public subscribe form
 *   POST /join/<group>         accept submission, store as 'pending'
 *   GET  /g/<group>            301 → /archive/<group> (legacy short link)
 *   /archive, /t/<id>, ...     archive browser (see ../archive/routes.ts)
 *   *                          tenant landing placeholder
 *
 * The form is server-rendered HTML — no SPA, no JS dependency on the admin
 * app. The page should be link-shareable in a church bulletin or text
 * message and load in <300ms on a phone.
 */

import type { Hono, Context } from "hono";
import {
  classifyHost,
  type InstanceConfig,
} from "@bulletinmail/shared";
import {
  appendAudit,
  getGroupByLocalpart,
  getMemberByEmail,
  getTenantBySlug,
  insertSubscriptionRequest,
  setDigestOptOutByToken,
  type Group,
  type Tenant,
} from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";
import { mountWikiRoutes } from "../wiki/routes.js";
import { mountArchiveRoutes } from "../archive/routes.js";
import { mountTenantDocs } from "./tenant-docs.js";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GROUP_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export function mountTenant(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  // Per-tenant wiki (root pages, /wiki/:slug, /auth/*, /api/wiki/*). Mount
  // FIRST so its specific paths win over the catch-all below.
  mountWikiRoutes(app);

  // Archive browser (/archive, /archive/:group, /t/:threadId, attachment
  // downloads, POST /auth/verify-code). Also before the catch-all.
  mountArchiveRoutes(app);

  // Tenant-facing docs at /docs — intercepts the ASSETS fallthrough, which
  // would otherwise serve the operator-oriented Starlight tree on this host.
  mountTenantDocs(app);

  // Tenant admin SPA at /admin/* — explicit ASSETS fallthrough. The tenant
  // catch-all below would otherwise eat /admin/styles.css, /admin/main.js,
  // and /admin/index.html and return its 'not yet implemented' placeholder.
  app.all("/admin", (c, next) => {
    if (classifyHostFromCtx(c).kind !== "tenant") return next();
    return c.env.ASSETS.fetch(c.req.raw);
  });
  app.all("/admin/*", (c, next) => {
    if (classifyHostFromCtx(c).kind !== "tenant") return next();
    return c.env.ASSETS.fetch(c.req.raw);
  });

  // GET /join/:group — render the form
  app.get("/join/:group", async (c, next) => {
    const result = classifyHostFromCtx(c);
    if (result.kind !== "tenant") return next();
    const groupLocal = c.req.param("group").toLowerCase();
    return renderJoinPage(c, result.slug, groupLocal);
  });

  // POST /join/:group — accept submission
  app.post("/join/:group", async (c, next) => {
    const result = classifyHostFromCtx(c);
    if (result.kind !== "tenant") return next();
    const groupLocal = c.req.param("group").toLowerCase();
    return handleJoinSubmit(c, result.slug, groupLocal);
  });

  // Weekly-digest opt-out — token-capability link from the digest footer.
  // GET shows a confirm page (mail scanners follow links; don't act on GET),
  // POST flips digest_opt_out for every membership sharing the email. This
  // is NOT a list unsubscribe — list mail keeps flowing.
  app.get("/digest/unsub/:token", async (c, next) => {
    if (classifyHostFromCtx(c).kind !== "tenant") return next();
    return c.html(digestOptOutConfirmPage(c.var.config, c.req.param("token")), 200);
  });

  app.post("/digest/unsub/:token", async (c, next) => {
    if (classifyHostFromCtx(c).kind !== "tenant") return next();
    const outcome = await setDigestOptOutByToken(c.env.DB, c.req.param("token"));
    if (!outcome) return c.html(notFoundPage(c.var.config), 404);
    await appendAudit(c.env.DB, {
      tenantId: outcome.tenantId,
      actor: `member:${outcome.email}`,
      action: "digest.opt_out",
      details: null,
    });
    return c.html(digestOptOutDonePage(c.var.config, outcome.email), 200);
  });

  // Existing tenant-subdomain catch-all (group archive short-link + landing).
  app.all("*", async (c, next) => {
    const result = classifyHostFromCtx(c);
    if (result.kind !== "tenant") return next();

    // Legacy short link /g/<group> → the real archive on this host.
    const match = /^\/g\/([^/]+)$/.exec(new URL(c.req.url).pathname);
    if (match) {
      const groupName = match[1]!;
      return c.redirect(`/archive/${groupName}`, 301);
    }

    return c.text(
      `${c.var.config.productName}: ${result.slug} (per-tenant page not yet implemented)`,
      200,
    );
  });
}

function classifyHostFromCtx(c: Ctx) {
  const host = c.req.header("Host") ?? "";
  return classifyHost(host, c.var.config);
}

async function loadTenantAndGroup(
  c: Ctx,
  tenantSlug: string,
  groupLocal: string,
): Promise<{ tenant: Tenant; group: Group } | null> {
  if (!GROUP_NAME_RE.test(groupLocal)) return null;
  const tenant = await getTenantBySlug(c.env.DB, tenantSlug);
  if (!tenant || tenant.status !== "active") return null;
  const group = await getGroupByLocalpart(c.env.DB, tenant.id, groupLocal);
  if (!group) return null;
  return { tenant, group };
}

async function renderJoinPage(c: Ctx, tenantSlug: string, groupLocal: string): Promise<Response> {
  const found = await loadTenantAndGroup(c, tenantSlug, groupLocal);
  if (!found) return c.html(notFoundPage(c.var.config), 404);
  const { tenant, group } = found;
  return c.html(joinFormPage({ config: c.var.config, tenant, group }), 200);
}

async function handleJoinSubmit(c: Ctx, tenantSlug: string, groupLocal: string): Promise<Response> {
  const found = await loadTenantAndGroup(c, tenantSlug, groupLocal);
  if (!found) return c.html(notFoundPage(c.var.config), 404);
  const { tenant, group } = found;

  // Form body is application/x-www-form-urlencoded.
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const about = String(form.get("about") ?? "").trim();
  const acknowledged = form.get("statement_ack") === "on" || form.get("statement_ack") === "1";
  // Honeypot — humans don't fill the hidden `phone_number` field; bots do.
  const honeypot = String(form.get("phone_number") ?? "").trim();

  if (honeypot) {
    // Silently accept-then-discard so the bot believes it succeeded.
    return c.html(submittedPage(c.var.config, tenant, group), 200);
  }

  const errors: string[] = [];
  if (!name) errors.push("Please tell us your name.");
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    errors.push("Please enter a valid email address.");
  }
  if (group.subscribe_statement && !acknowledged) {
    errors.push("You must read and acknowledge the statement to subscribe.");
  }
  if (about.length > 2000) errors.push("Please keep the 'about you' to under 2000 characters.");
  if (name.length > 120) errors.push("Please keep your name under 120 characters.");

  if (errors.length > 0) {
    return c.html(
      joinFormPage({
        config: c.var.config, tenant, group,
        errors,
        prefill: { name, email, about },
      }),
      400,
    );
  }

  // If they're already an active member, short-circuit with a friendlier message.
  const existing = await getMemberByEmail(c.env.DB, group.id, email);
  if (existing && existing.status === "active") {
    return c.html(alreadySubscribedPage(c.var.config, tenant, group), 200);
  }

  const newId = await insertSubscriptionRequest(c.env.DB, {
    groupId: group.id,
    email,
    displayName: name,
    about: about || null,
  });
  // `null` from insertSubscriptionRequest = pending duplicate. Treat as success
  // from the user's POV — their previous submission is still on the queue.
  void newId;

  return c.html(submittedPage(c.var.config, tenant, group), 200);
}

// ---- HTML rendering ---------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

type JoinPageInput = {
  config: InstanceConfig;
  tenant: Tenant;
  group: Group;
  errors?: string[];
  prefill?: { name: string; email: string; about: string };
};

function joinFormPage({ config, tenant, group, errors, prefill }: JoinPageInput): string {
  const prefillName = esc(prefill?.name ?? "");
  const prefillEmail = esc(prefill?.email ?? "");
  const prefillAbout = esc(prefill?.about ?? "");
  const errorBlock = errors && errors.length > 0
    ? `<div class="banner err"><strong>Please fix the following:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";

  const statementBlock = group.subscribe_statement
    ? `<fieldset class="statement">
         <legend>Please read</legend>
         <div class="statement-body">${esc(group.subscribe_statement).replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>").replace(/^/, "<p>") + "</p>"}</div>
         <label class="ack">
           <input type="checkbox" name="statement_ack" value="on" required>
           I have read the above and agree.
         </label>
       </fieldset>`
    : "";

  return shellHtml(config, `${tenant.display_name} — Subscribe to ${group.display_name}`, `
    <header>
      <p class="kicker">${esc(tenant.display_name)}</p>
      <h1>Subscribe to ${esc(group.display_name)}</h1>
      ${group.description ? `<p class="lede">${esc(group.description)}</p>` : ""}
    </header>

    ${errorBlock}

    <form method="post" action="/join/${esc(group.name)}" novalidate>
      <label>
        <span>Your name</span>
        <input type="text" name="name" value="${prefillName}" required maxlength="120" autocomplete="name">
      </label>
      <label>
        <span>Email address</span>
        <input type="email" name="email" value="${prefillEmail}" required maxlength="254" autocomplete="email">
      </label>
      <label>
        <span>Anything you'd like the moderators to know? <em class="small muted">(optional)</em></span>
        <textarea name="about" rows="4" maxlength="2000">${prefillAbout}</textarea>
      </label>

      <!-- Honeypot: hidden via CSS. Humans leave it empty. -->
      <label class="honeypot" aria-hidden="true">
        Phone number
        <input type="text" name="phone_number" tabindex="-1" autocomplete="off">
      </label>

      ${statementBlock}

      <button type="submit" class="primary">Submit subscription request</button>
      <p class="small muted">A moderator will review your request within <strong>3 business days</strong>. You'll receive your first list email after approval.</p>
    </form>
  `);
}

function submittedPage(config: InstanceConfig, tenant: Tenant, group: Group): string {
  return shellHtml(config, "Subscription request received", `
    <header>
      <p class="kicker">${esc(tenant.display_name)}</p>
      <h1>Thanks — we got it.</h1>
    </header>
    <p>Your request to subscribe to <strong>${esc(group.display_name)}</strong> has been submitted.</p>
    <p>A moderator will review it within <strong>3 business days</strong>. After approval you'll start receiving messages at the email you provided.</p>
    <p class="small muted">If you don't hear back after a week, you can resubmit this form or contact the organization directly.</p>
  `);
}

function alreadySubscribedPage(config: InstanceConfig, tenant: Tenant, group: Group): string {
  return shellHtml(config, "Already subscribed", `
    <header>
      <p class="kicker">${esc(tenant.display_name)}</p>
      <h1>You're already on this list.</h1>
    </header>
    <p>The email you submitted is already an active subscriber to <strong>${esc(group.display_name)}</strong>. No action needed — you should be receiving messages.</p>
    <p class="small muted">If you're not getting messages, check your spam folder or contact the list moderator.</p>
  `);
}

function digestOptOutConfirmPage(config: InstanceConfig, token: string): string {
  return shellHtml(config, "Stop the weekly digest?", `
    <h1>Stop the weekly digest?</h1>
    <p>You'll no longer receive the weekly activity summary email. Regular list messages are <strong>not</strong> affected — this only stops the digest.</p>
    <form method="post" action="/digest/unsub/${esc(token)}">
      <button type="submit" class="primary">Stop sending me the digest</button>
    </form>
  `);
}

function digestOptOutDonePage(config: InstanceConfig, email: string): string {
  return shellHtml(config, "Digest stopped", `
    <h1>Done.</h1>
    <p>The weekly digest will no longer be sent to <strong>${esc(email)}</strong>. Regular list messages continue as before.</p>
  `);
}

function notFoundPage(config: InstanceConfig): string {
  return shellHtml(config, "Not found", `
    <h1>List not found</h1>
    <p>This subscribe link is for a list that doesn't exist (or has been removed). Please check the URL you were given.</p>
  `);
}

export function shellHtml(_config: InstanceConfig, title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>
  :root { --bg:#fdfcfa; --fg:#1a1a1a; --muted:#6b6b6b; --line:#e2e2e0; --accent:#0f172a; --err:#b91c1c; --ok:#166534; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#f4f4f4; --muted:#8a8a8a; --line:#2a2a2a; --accent:#f4f4f4; } }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; }
  main { max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; }
  header { margin-bottom: 1.5rem; }
  .kicker { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 0.25rem; }
  h1 { font-size: 1.75rem; margin: 0 0 0.5rem; line-height: 1.2; }
  .lede { color: var(--muted); font-size: 1.05rem; margin: 0.5rem 0 0; }
  form { display: grid; gap: 1rem; margin-top: 1.5rem; }
  label { display: grid; gap: 0.3rem; font-size: 0.9rem; }
  label span { font-weight: 500; }
  input[type="text"], input[type="email"], textarea {
    font: inherit; padding: 0.55rem 0.7rem; border: 1px solid var(--line); border-radius: 4px;
    background: var(--bg); color: var(--fg); width: 100%;
  }
  textarea { font-family: inherit; resize: vertical; min-height: 5rem; }
  fieldset.statement { border: 1px solid var(--line); border-radius: 4px; padding: 0.9rem 1rem; margin: 0; }
  fieldset.statement legend { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 0 0.4rem; }
  .statement-body { font-size: 0.95rem; max-height: 16rem; overflow-y: auto; padding-right: 0.25rem; }
  .statement-body p { margin: 0 0 0.75rem; }
  label.ack { flex-direction: row; align-items: center; margin-top: 0.75rem; display: flex; gap: 0.5rem; font-size: 0.95rem; }
  label.ack input { width: auto; }
  button.primary { font: inherit; padding: 0.65rem 1.1rem; border: 0; border-radius: 4px; background: var(--accent); color: var(--bg); cursor: pointer; }
  button.primary:hover { opacity: 0.9; }
  .small { font-size: 0.875rem; }
  .muted { color: var(--muted); }
  em.small { font-style: normal; }
  .banner.err { border: 1px solid var(--err); color: var(--err); background: rgba(185, 28, 28, 0.07); padding: 0.6rem 0.85rem; border-radius: 4px; font-size: 0.9rem; }
  .banner.err ul { margin: 0.3rem 0 0 1.1rem; padding: 0; }
  /* Honeypot: hide off-screen, NOT display:none (some bots check that). */
  .honeypot { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
${extraCss}</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`;
}
