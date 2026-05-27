/**
 * One-click unsubscribe — RFC 8058.
 *
 *   GET  /u/:token   → confirmation HTML showing what the user is about to
 *                      unsubscribe from. Defense against mail-client safe-
 *                      browsing scanners that blindly follow links.
 *   POST /u/:token   with body `List-Unsubscribe=One-Click` → immediate
 *                      unsubscribe, 200, no confirmation page.
 *
 * Both must respond in < 1 second per RFC 8058.
 *
 * The mailto: form (`unsubscribe+{token}@<apex>`) is handled by the inbound
 * worker via a special recipient-pattern check before normal group resolution.
 *
 * See PRD §8.4.
 */

import type { Hono } from "hono";
import { resolveUnsubToken, unsubscribeByToken } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function mountUnsub(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/u/:token", async (c) => {
    const token = c.req.param("token");
    const resolved = await resolveUnsubToken(c.env.DB, token);

    if (!resolved) {
      return c.html(notFoundPage(c.var.config.productName), 404);
    }

    const { member, group } = resolved;
    if (member.status === "unsubscribed") {
      return c.html(alreadyUnsubscribedPage(c.var.config.productName, member.email, group.display_name), 200);
    }

    return c.html(confirmPage(c.var.config.productName, member.email, group.display_name), 200);
  });

  app.post("/u/:token", async (c) => {
    const token = c.req.param("token");
    const outcome = await unsubscribeByToken(c.env.DB, token);

    if (outcome === "not_found") {
      // Per RFC 8058 the response on a one-click POST should be quick and
      // simple; mail clients don't render it. 410 is more accurate than 404
      // for "this used to exist but the token never did," but we don't
      // distinguish — so 404 is fine.
      return c.text("Token not recognized.", 404);
    }

    // Both "unsubscribed" and "already" → 200. Mail clients don't show this
    // body to the user; they only care about the status code.
    return c.text("Unsubscribed.", 200);
  });
}

function confirmPage(productName: string, email: string, groupDisplayName: string): string {
  return shell(
    productName,
    `<h1>Unsubscribe ${escapeHtml(email)}?</h1>
     <p>You're about to unsubscribe from <strong>${escapeHtml(groupDisplayName)}</strong>.</p>
     <form method="post"><button class="danger">Yes, unsubscribe me</button></form>
     <p class="small">You can resubscribe at any time by asking your list administrator.</p>`,
  );
}

function alreadyUnsubscribedPage(productName: string, email: string, groupDisplayName: string): string {
  return shell(
    productName,
    `<h1>Already unsubscribed</h1>
     <p><strong>${escapeHtml(email)}</strong> is no longer subscribed to
       <strong>${escapeHtml(groupDisplayName)}</strong>.</p>`,
  );
}

function notFoundPage(productName: string): string {
  return shell(
    productName,
    `<h1>Link not recognized</h1>
     <p>This unsubscribe link is invalid or expired. If you're still getting
     messages you don't want, contact your list administrator.</p>`,
  );
}

function shell(productName: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(productName)}</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #444; }
    .small { color: #888; font-size: 0.875rem; }
    button { font: inherit; padding: 0.6rem 1.2rem; cursor: pointer; border-radius: 4px; border: 1px solid #ccc; background: #fafafa; }
    button.danger { background: #c2410c; color: white; border-color: #9a3412; }
    button.danger:hover { background: #9a3412; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
