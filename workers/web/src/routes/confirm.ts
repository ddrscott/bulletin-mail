/**
 * Double-opt-in confirmation — paired with admin-added members.
 *
 *   GET  /c/:token   confirmation HTML page
 *   POST /c/:token   confirm → set member.status = 'active'
 *
 * Same token model as /u/:token (one opaque unsub token per member) so we
 * don't need a second token table. /u/ keeps its decline meaning;
 * /c/ promotes the same member from pending_confirmation to active.
 */

import type { Hono } from "hono";
import { confirmMember, resolveUnsubToken } from "@bulletinmail/db";
import type { AppVariables, Env } from "../types.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function mountConfirm(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.get("/c/:token", async (c) => {
    const token = c.req.param("token");
    const resolved = await resolveUnsubToken(c.env.DB, token);
    if (!resolved) {
      return c.html(notFoundPage(c.var.config.productName), 404);
    }
    const { member, group } = resolved;
    if (member.status === "active") {
      return c.html(alreadyActivePage(c.var.config.productName, member.email, group.display_name), 200);
    }
    if (member.status === "unsubscribed") {
      return c.html(declinedPage(c.var.config.productName, member.email, group.display_name), 200);
    }
    return c.html(confirmPage(c.var.config.productName, member.email, group.display_name), 200);
  });

  app.post("/c/:token", async (c) => {
    const token = c.req.param("token");
    const resolved = await resolveUnsubToken(c.env.DB, token);
    if (!resolved) return c.text("Token not recognized.", 404);
    const outcome = await confirmMember(c.env.DB, resolved.member.id);
    if (outcome === "not_found") return c.text("This subscription was declined or removed; ask the list admin to re-add you.", 410);
    // outcome === "confirmed" or "already" → 200 + happy page.
    return c.html(confirmedPage(c.var.config.productName, resolved.member.email, resolved.group.display_name), 200);
  });
}

function confirmPage(productName: string, email: string, groupDisplayName: string): string {
  return shell(productName, `
    <h1>Confirm subscription</h1>
    <p>Click below to subscribe <strong>${escapeHtml(email)}</strong> to <strong>${escapeHtml(groupDisplayName)}</strong>.</p>
    <form method="post"><button class="primary">Yes, subscribe me</button></form>
    <p class="small">Didn't expect this email? Just close this tab and you won't receive anything.</p>
  `);
}

function confirmedPage(productName: string, email: string, groupDisplayName: string): string {
  return shell(productName, `
    <h1>You're subscribed</h1>
    <p><strong>${escapeHtml(email)}</strong> will now receive messages from <strong>${escapeHtml(groupDisplayName)}</strong>.</p>
  `);
}

function alreadyActivePage(productName: string, email: string, groupDisplayName: string): string {
  return shell(productName, `
    <h1>Already subscribed</h1>
    <p><strong>${escapeHtml(email)}</strong> is already an active subscriber to <strong>${escapeHtml(groupDisplayName)}</strong>. No action needed.</p>
  `);
}

function declinedPage(productName: string, email: string, groupDisplayName: string): string {
  return shell(productName, `
    <h1>Subscription declined</h1>
    <p><strong>${escapeHtml(email)}</strong> previously declined or unsubscribed from <strong>${escapeHtml(groupDisplayName)}</strong>. Ask the list admin to add you again if this was a mistake.</p>
  `);
}

function notFoundPage(productName: string): string {
  return shell(productName, `
    <h1>Link not recognized</h1>
    <p>This confirmation link is invalid or expired. If you're trying to subscribe to a list, ask the list admin to add you again.</p>
  `);
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
    button.primary { background: #0f172a; color: white; border-color: #0f172a; }
    button.primary:hover { background: #1e293b; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
