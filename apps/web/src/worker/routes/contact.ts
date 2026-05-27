/**
 * Contact page — apex-only marketing intake.
 *
 *   GET  /contact   form (name, email, reason, message)
 *   POST /contact   validate → forward to env.DISCORD_WEBHOOK → success page
 *
 * Pattern mirrors /c/ and /u/: server-rendered HTML, inline CSS, no JS.
 * Posts back to itself; success and validation errors are server-rendered
 * inline so the page works without JavaScript.
 *
 * The instance config's `operator.contactUrl` points at this path
 * (`/contact` by convention). Forks that prefer a different contact channel
 * can replace this route — the path is the only contract.
 */

import type { Hono } from "hono";
import type { AppVariables, Env } from "../types.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const REASONS = [
  { value: "waitlist", label: "Hosted-service waitlist", emoji: "📬" },
  { value: "self-host", label: "Self-hosting help", emoji: "🛠" },
  { value: "press", label: "Press / partnership", emoji: "📰" },
  { value: "other", label: "Other", emoji: "📝" },
] as const;
type ReasonValue = (typeof REASONS)[number]["value"];

const isReason = (v: string): v is ReasonValue =>
  REASONS.some((r) => r.value === v);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mountContact(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
): void {
  app.get("/contact", (c) =>
    c.html(formPage(c.var.config.productName, null, {})),
  );

  app.post("/contact", async (c) => {
    const form = await c.req.formData();
    const name = (form.get("name") ?? "").toString().trim();
    const email = (form.get("email") ?? "").toString().trim();
    const reasonRaw = (form.get("reason") ?? "").toString().trim();
    const message = (form.get("message") ?? "").toString().trim();

    const fieldErrors: Record<string, string> = {};
    if (!EMAIL_RE.test(email)) fieldErrors.email = "Enter a valid email address.";
    if (!isReason(reasonRaw)) fieldErrors.reason = "Pick a reason.";
    if (message.length < 1) fieldErrors.message = "Add a short message.";
    if (message.length > 4000) fieldErrors.message = "Message is too long (max 4000 chars).";
    if (name.length > 200) fieldErrors.name = "Name is too long.";

    if (Object.keys(fieldErrors).length > 0) {
      return c.html(
        formPage(c.var.config.productName, fieldErrors, { name, email, reason: reasonRaw, message }),
        400,
      );
    }

    const reason = reasonRaw as ReasonValue;
    const reasonMeta = REASONS.find((r) => r.value === reason)!;

    const payload = {
      embeds: [
        {
          title: `${reasonMeta.emoji} ${reasonMeta.label}`,
          color: 0x0a0a0a,
          fields: [
            { name: "Name", value: name || "(none)", inline: true },
            { name: "Email", value: email, inline: true },
            { name: "Reason", value: reason, inline: true },
            { name: "Message", value: message.slice(0, 1024) },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      const res = await fetch(c.env.DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error("Discord webhook failed:", res.status, await res.text());
        return c.html(errorPage(c.var.config.productName), 502);
      }
    } catch (err) {
      console.error("Discord webhook error:", err);
      return c.html(errorPage(c.var.config.productName), 502);
    }

    return c.html(successPage(c.var.config.productName, email), 200);
  });
}

function formPage(
  productName: string,
  errors: Record<string, string> | null,
  values: { name?: string; email?: string; reason?: string; message?: string },
): string {
  const v = {
    name: escapeHtml(values.name ?? ""),
    email: escapeHtml(values.email ?? ""),
    reason: values.reason ?? "",
    message: escapeHtml(values.message ?? ""),
  };
  const err = (field: string): string =>
    errors?.[field]
      ? `<p class="err">${escapeHtml(errors[field])}</p>`
      : "";
  const banner = errors
    ? `<p class="banner banner--err">Couldn't send — fix the highlighted fields below.</p>`
    : "";

  const reasonOptions = REASONS.map(
    (r) =>
      `<option value="${r.value}"${v.reason === r.value ? " selected" : ""}>${escapeHtml(r.label)}</option>`,
  ).join("");

  return shell(
    productName,
    `<h1>Get in touch</h1>
<p class="lede">Tell us what brings you here. Replies usually come within a couple of days from a human; we don't add you to any list.</p>
${banner}
<form method="post" novalidate>
  <label>
    <span>Name <em>optional</em></span>
    <input type="text" name="name" value="${v.name}" maxlength="200" autocomplete="name">
    ${err("name")}
  </label>

  <label>
    <span>Email</span>
    <input type="email" name="email" value="${v.email}" required maxlength="200" autocomplete="email">
    ${err("email")}
  </label>

  <label>
    <span>Reason</span>
    <select name="reason" required>
      <option value="">— pick one —</option>
      ${reasonOptions}
    </select>
    ${err("reason")}
  </label>

  <label>
    <span>Message</span>
    <textarea name="message" rows="6" required maxlength="4000">${v.message}</textarea>
    ${err("message")}
  </label>

  <button type="submit" class="primary">Send →</button>
</form>`,
  );
}

function successPage(productName: string, email: string): string {
  return shell(
    productName,
    `<h1>Thanks — we got it.</h1>
<p>We'll reply to <strong>${escapeHtml(email)}</strong> when we have something useful to say. No mailing list, no drip campaign.</p>
<p><a href="/">← Back to the front page</a></p>`,
  );
}

function errorPage(productName: string): string {
  return shell(
    productName,
    `<h1>Couldn't send your message</h1>
<p>Something went wrong on our end relaying your message. Try again in a minute, or email <a href="mailto:legal@bulletinmail.org">legal@bulletinmail.org</a> if it keeps failing.</p>
<p><a href="/contact">← Try again</a></p>`,
  );
}

function shell(productName: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contact — ${escapeHtml(productName)}</title>
  <style>
    :root { color-scheme: light; }
    body { font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; max-width: 38rem; margin: 3rem auto 6rem; padding: 0 1.25rem; color: #1a1a1a; background: #f8f6f2; }
    a { color: #1a1a1a; text-underline-offset: 2px; }
    a:hover { background: #ede9e3; }
    h1 { font-family: ui-serif, "Source Serif", Georgia, serif; font-size: 2rem; line-height: 1.1; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
    .lede { font-family: ui-serif, "Source Serif", Georgia, serif; font-size: 1.05rem; font-style: italic; color: #1a1a1a; margin: 0 0 1.5rem; max-width: 50ch; }
    p { margin: 0 0 1rem; }
    label { display: block; margin-bottom: 1rem; }
    label > span { display: block; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #5a5a5a; margin-bottom: 0.25rem; }
    label > span em { font-style: normal; font-weight: 400; text-transform: none; letter-spacing: 0; color: #8a8a8a; margin-left: 0.5em; }
    input, textarea, select { font: inherit; width: 100%; padding: 0.55rem 0.7rem; background: #fff; border: 1px solid #c8c2b6; border-radius: 2px; color: #1a1a1a; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #1a1a1a; outline-offset: 1px; border-color: #1a1a1a; }
    textarea { resize: vertical; min-height: 8rem; font-family: inherit; }
    button { font: inherit; padding: 0.55rem 1.3rem; border: 1px solid #1a1a1a; border-radius: 2px; background: #fff; color: #1a1a1a; cursor: pointer; }
    button.primary { background: #1a1a1a; color: #f8f6f2; }
    button.primary:hover { background: #333; }
    .err { color: #a00; font-size: 0.85rem; margin: 0.25rem 0 0; }
    .banner { padding: 0.6rem 0.8rem; border: 1px solid; margin: 0 0 1.25rem; font-size: 0.92rem; }
    .banner--err { border-color: #a00; background: #fbe8e8; color: #5a0000; }
    nav { font-family: ui-monospace, "IBM Plex Mono", Menlo, monospace; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: #5a5a5a; margin-bottom: 2rem; }
    nav a { color: #5a5a5a; text-decoration: none; }
    nav a:hover { color: #1a1a1a; background: transparent; }
  </style>
</head>
<body>
<nav><a href="/">${escapeHtml(productName)}</a> · Contact</nav>
${body}
</body>
</html>`;
}
