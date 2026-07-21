/**
 * Server-rendered HTML for the archive browser. Same idiom as the wiki
 * shell: plain template strings, /admin/styles.css design tokens, zero
 * client-side JS. Threads are permalinked at /t/<thread-id> — the weekly
 * digest (roadmap part 4) will link straight here.
 */

import type { Group, GroupWithStats, Message, Attachment, ThreadSummary, Tenant } from "@bulletinmail/db";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Obfuscate an email for display (PRD §10 V2 archive: "Email addresses
 * obfuscated in HTML"). "scott@example.com" → "scott@e…". Exported for
 * tests.
 */
export function obfuscateEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domainFirst = email.slice(at + 1, at + 2);
  return `${local}@${domainFirst}…`;
}

/** Sender display: prefer the human name, fall back to obfuscated email. */
export function senderLabel(fromName: string | null, fromEmail: string): string {
  const name = (fromName ?? "").trim();
  return name !== "" ? name : obfuscateEmail(fromEmail);
}

/** "3.4 MB" style size label. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Coarse relative time — same shape as the wiki activity feed's. */
export function relativeTime(ts: number, now: number = Date.now()): string {
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

function absoluteTime(ts: number): string {
  const d = new Date(ts);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

// Lucide "paperclip" — inline SVG, no icon font, no emoji.
const PAPERCLIP_SVG =
  `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Has attachments" role="img"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

// Lucide "send" — submit buttons on the post forms.
const SEND_SVG =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>`;

/**
 * State for the reply / new-thread forms. `null`/`undefined` on a page means
 * "viewer may not post here" — the form isn't rendered at all (matching the
 * email path, where the rejection happens at the SMTP boundary).
 */
export type PostFormState = {
  /** When set, the Cloudflare Turnstile widget is embedded in the form. */
  turnstileSiteKey: string | null;
  /** Show the "your post was sent" confirmation banner (post-redirect GET). */
  posted?: boolean | undefined;
  /** Validation / permission errors to show above the form. */
  errors?: string[] | undefined;
  draftSubject?: string | undefined;
  draftBody?: string | undefined;
};

/** Turnstile widget + loader script — only when a site key is configured. */
function turnstileBlock(siteKey: string | null): string {
  if (!siteKey) return "";
  return `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>`;
}

function postBanners(form: PostFormState, postedText: string): string {
  const posted = form.posted ? `<div class="banner ok">${esc(postedText)}</div>` : "";
  const errors = form.errors && form.errors.length > 0
    ? `<div class="banner err"><ul>${form.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  return posted + errors;
}

type ShellOpts = {
  tenant: Tenant;
  productName: string;
  title: string;
  /** Dateline breadcrumb segments; last one is rendered bold, others link. */
  crumbs: Array<{ label: string; href?: string }>;
  viewerLabel: string | null;
  body: string;
};

function shell({ tenant, productName, title, crumbs, viewerLabel, body }: ShellOpts): string {
  const crumbHtml = crumbs
    .map((cr, i) =>
      i === crumbs.length - 1 || !cr.href
        ? `<strong>${esc(cr.label)}</strong>`
        : `<a href="${esc(cr.href)}">${esc(cr.label)}</a>`,
    )
    .join(`<span class="sep">·</span>`);
  const right = viewerLabel
    ? `<form method="post" action="/auth/sign-out" class="masthead__right signout-form"><span class="viewer">${esc(viewerLabel)}</span><button type="submit" class="linklike">Sign out</button></form>`
    : `<a class="masthead__right" href="/auth/sign-in">Sign in</a>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — ${esc(tenant.display_name)}</title>
<link rel="stylesheet" href="/admin/styles.css">
<style>
  main.archive-main { max-width: var(--width-prose); margin: 0 auto; padding: var(--space-6) 0 var(--space-9); }
  main.archive-main h1 { font-size: var(--text-2xl); margin: 0 0 var(--space-2); }
  main.archive-main p.lede { color: var(--ink-muted); margin: 0 0 var(--space-6); }
  .signout-form { display: inline-flex; align-items: center; gap: var(--space-3); }
  .signout-form .viewer { color: var(--ink-muted); font-size: var(--text-xs); }
  .signout-form button.linklike { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; color: inherit; }
  ul.rowlist { list-style: none; margin: 0; padding: 0; }
  ul.rowlist > li { padding: var(--space-4) 0; border-bottom: var(--hairline); }
  ul.rowlist > li:last-child { border-bottom: 0; }
  .row-title { font: 600 var(--text-base) var(--font-sans); margin: 0 0 var(--space-1); }
  .row-title a { text-decoration: none; border-bottom: 1px dashed currentColor; color: var(--ink); }
  .row-title a:hover { background: var(--paper-2); }
  .row-meta { font: var(--text-xs)/1.4 var(--font-mono); color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .row-meta .sep { padding: 0 var(--space-2); }
  .row-meta .icon { vertical-align: -2px; }
  .row-desc { margin: var(--space-1) 0 0; color: var(--ink-muted); font-size: var(--text-sm); }
  nav.pager { display: flex; justify-content: space-between; margin-top: var(--space-6); font: var(--text-xs)/1.4 var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; }
  nav.pager a { color: var(--ink); }
  nav.pager .disabled { color: var(--ink-muted); }
  article.msg { padding: var(--space-5) 0; border-bottom: var(--hairline); }
  article.msg:last-of-type { border-bottom: 0; }
  article.msg header { margin-bottom: var(--space-3); }
  article.msg .msg-from { font-weight: 700; }
  article.msg .msg-when { font: var(--text-xs)/1.4 var(--font-mono); color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .msg-body { overflow-wrap: anywhere; }
  .msg-body img { max-width: 100%; height: auto; }
  .msg-body blockquote { border-left: 2px solid var(--rule); margin: var(--space-3) 0; padding: 0 0 0 var(--space-3); color: var(--ink-muted); }
  .msg-body .plain-body .quote { color: var(--ink-muted); }
  .msg-body img.blocked-remote-img { display: inline-block; min-width: 1.5rem; min-height: 1.5rem; background: var(--paper-2); border: 1px dashed var(--rule); }
  ul.att-list { list-style: none; margin: var(--space-3) 0 0; padding: var(--space-3) 0 0; border-top: 1px dashed var(--rule); }
  ul.att-list li { font-size: var(--text-sm); padding: 2px 0; }
  ul.att-list .att-size { color: var(--ink-muted); font-size: var(--text-xs); }
  .empty { color: var(--ink-muted); padding: var(--space-5) 0; }
  .banner { padding: var(--space-3) var(--space-4); border-radius: 4px; margin: 0 0 var(--space-5); font-size: var(--text-sm); }
  .banner.ok { border: 1px solid #166534; color: #166534; background: rgba(22, 101, 52, 0.07); }
  .banner.err { border: 1px solid #b91c1c; color: #b91c1c; background: rgba(185, 28, 28, 0.07); }
  .banner ul { margin: 0 0 0 1.1rem; padding: 0; }
  section.postbox { margin-top: var(--space-7); padding-top: var(--space-5); border-top: var(--hairline); }
  section.postbox h2 { font-size: var(--text-lg); margin: 0 0 var(--space-3); }
  .postbox form { display: grid; gap: var(--space-3); }
  .postbox input[type="text"], .postbox textarea { font: inherit; width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--rule); border-radius: 4px; background: transparent; color: var(--ink); }
  .postbox textarea { resize: vertical; min-height: 8rem; }
  .postbox button.primary { justify-self: start; display: inline-flex; align-items: center; gap: var(--space-2); font: inherit; padding: var(--space-2) var(--space-4); border: 0; border-radius: 4px; background: var(--ink); color: var(--paper); cursor: pointer; }
  .postbox button.primary:hover { opacity: 0.9; }
  .postbox .form-note { font-size: var(--text-xs); color: var(--ink-muted); margin: 0; }
</style>
</head><body>
<div class="app-shell">
  <header class="masthead masthead--tenant">
    <h1 class="wordmark wordmark--with-kicker">
      <span class="wordmark__kicker">${esc(productName)}</span>
      <a href="/">${esc(tenant.display_name)}</a>
    </h1>
    ${right}
  </header>
  <div class="dateline dateline--row">
    <div class="dateline__nav">
      <a href="/">Wiki</a><span class="sep">·</span>${crumbHtml}
    </div>
  </div>
  <main class="archive-main">${body}</main>
  <footer class="wiki-footer" style="margin-top: var(--space-7); padding: var(--space-5) 0; border-top: var(--hairline); font: var(--text-xs)/1.5 var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted);"><a href="/archive">Archive</a> · Powered by ${esc(productName)}</footer>
</div>
</body></html>`;
}

// ---- pages ------------------------------------------------------------------

export function renderGroupIndexPage(opts: {
  tenant: Tenant;
  productName: string;
  viewerLabel: string;
  groups: GroupWithStats[];
}): string {
  const items = opts.groups.length === 0
    ? `<li class="empty">No lists are visible to you yet. If you expect to see one, check that you signed in with your subscribed email address.</li>`
    : opts.groups.map((g) => `<li>
        <h2 class="row-title"><a href="/archive/${esc(g.name)}">${esc(g.display_name)}</a></h2>
        ${g.description ? `<p class="row-desc">${esc(g.description)}</p>` : ""}
        <p class="row-meta">${g.active_member_count} member${g.active_member_count === 1 ? "" : "s"}${g.last_message_at ? `<span class="sep">·</span>last message ${esc(relativeTime(g.last_message_at))}` : `<span class="sep">·</span>no messages yet`}</p>
      </li>`).join("");

  return shell({
    tenant: opts.tenant,
    productName: opts.productName,
    title: "Archive",
    crumbs: [{ label: "Archive" }],
    viewerLabel: opts.viewerLabel,
    body: `<h1>List archive</h1>
      <p class="lede">Every message sent to your lists, browsable and permanent. Pick a list to see its threads.</p>
      <ul class="rowlist">${items}</ul>`,
  });
}

export function renderThreadListPage(opts: {
  tenant: Tenant;
  productName: string;
  viewerLabel: string;
  group: Group;
  threads: ThreadSummary[];
  page: number;
  totalPages: number;
  /** Render the "start a new thread" form. Omit when the viewer can't post. */
  newThreadForm?: PostFormState | null;
}): string {
  const items = opts.threads.length === 0
    ? `<li class="empty">No messages in this list yet.</li>`
    : opts.threads.map((t) => `<li>
        <h2 class="row-title"><a href="/t/${esc(t.thread_id)}">${esc(t.subject || "(no subject)")}</a></h2>
        <p class="row-meta">
          ${esc(senderLabel(t.root_from_name, t.root_from_email))}<span class="sep">·</span>${t.message_count} message${t.message_count === 1 ? "" : "s"}<span class="sep">·</span>${t.participant_count} participant${t.participant_count === 1 ? "" : "s"}<span class="sep">·</span>${esc(relativeTime(t.last_activity_at))}${t.has_attachments ? `<span class="sep">·</span>${PAPERCLIP_SVG}` : ""}
        </p>
      </li>`).join("");

  const prev = opts.page > 1
    ? `<a href="/archive/${esc(opts.group.name)}?page=${opts.page - 1}">Newer threads</a>`
    : `<span class="disabled">Newer threads</span>`;
  const next = opts.page < opts.totalPages
    ? `<a href="/archive/${esc(opts.group.name)}?page=${opts.page + 1}">Older threads</a>`
    : `<span class="disabled">Older threads</span>`;
  const pager = opts.totalPages > 1
    ? `<nav class="pager">${prev}<span>Page ${opts.page} of ${opts.totalPages}</span>${next}</nav>`
    : "";

  const f = opts.newThreadForm;
  const postBox = f
    ? `<section class="postbox" id="new-thread">
        <h2>Start a new thread</h2>
        ${postBanners(f, "Your post was sent to the list.")}
        <form method="post" action="/archive/${esc(opts.group.name)}/new">
          <input type="text" name="subject" required maxlength="180" placeholder="Subject" value="${esc(f.draftSubject ?? "")}" aria-label="Subject">
          <textarea name="body" rows="8" required maxlength="32000" placeholder="Write your message — plain text. It is emailed to every member of the list." aria-label="Message body">${esc(f.draftBody ?? "")}</textarea>
          ${turnstileBlock(f.turnstileSiteKey)}
          <button type="submit" class="primary">${SEND_SVG} Send to the list</button>
          <p class="form-note">Your post is emailed to every member of ${esc(opts.group.display_name)} and appears here immediately.</p>
        </form>
      </section>`
    : "";

  return shell({
    tenant: opts.tenant,
    productName: opts.productName,
    title: `${opts.group.display_name} archive`,
    crumbs: [{ label: "Archive", href: "/archive" }, { label: opts.group.display_name }],
    viewerLabel: opts.viewerLabel,
    body: `<h1>${esc(opts.group.display_name)}</h1>
      ${opts.group.description ? `<p class="lede">${esc(opts.group.description)}</p>` : ""}
      <ul class="rowlist">${items}</ul>
      ${pager}
      ${postBox}`,
  });
}

export type RenderedMessage = {
  message: Message;
  /** Sanitized HTML body OR rendered plain text — already safe to embed. */
  bodyHtml: string;
  attachments: Attachment[];
};

export function renderThreadPage(opts: {
  tenant: Tenant;
  productName: string;
  viewerLabel: string;
  group: Group;
  threadId: string;
  subject: string;
  messages: RenderedMessage[];
  /** Render the reply form. Omit when the viewer can't post to this group. */
  replyForm?: PostFormState | null;
}): string {
  const articles = opts.messages.map(({ message: m, bodyHtml, attachments }) => {
    const atts = attachments.length === 0 ? "" : `<ul class="att-list">${attachments
      .map((a) => `<li>${PAPERCLIP_SVG} <a href="/archive/att/${esc(a.id)}">${esc(a.filename)}</a> <span class="att-size">${esc(formatBytes(a.size_bytes))}</span></li>`)
      .join("")}</ul>`;
    return `<article class="msg" id="m-${esc(m.id)}">
      <header>
        <span class="msg-from">${esc(senderLabel(m.from_name, m.from_email))}</span>
        <div class="msg-when"><a href="#m-${esc(m.id)}" style="color:inherit;text-decoration:none">${esc(absoluteTime(m.received_at))} · ${esc(relativeTime(m.received_at))}</a></div>
      </header>
      <div class="msg-body">${bodyHtml}</div>
      ${atts}
    </article>`;
  }).join("");

  const f = opts.replyForm;
  const postBox = f
    ? `<section class="postbox" id="reply">
        <h2>Reply to this thread</h2>
        ${postBanners(f, "Your reply was sent to the list.")}
        <form method="post" action="/t/${esc(opts.threadId)}/reply">
          <textarea name="body" rows="8" required maxlength="32000" placeholder="Write your reply — plain text. It is emailed to every member of the list." aria-label="Reply body">${esc(f.draftBody ?? "")}</textarea>
          ${turnstileBlock(f.turnstileSiteKey)}
          <button type="submit" class="primary">${SEND_SVG} Send to the list</button>
          <p class="form-note">Your reply is emailed to every member of ${esc(opts.group.display_name)} and threads with this conversation in their mail clients.</p>
        </form>
      </section>`
    : "";

  return shell({
    tenant: opts.tenant,
    productName: opts.productName,
    title: opts.subject || "(no subject)",
    crumbs: [
      { label: "Archive", href: "/archive" },
      { label: opts.group.display_name, href: `/archive/${opts.group.name}` },
      { label: "Thread" },
    ],
    viewerLabel: opts.viewerLabel,
    body: `<h1>${esc(opts.subject || "(no subject)")}</h1>
      <p class="lede">${opts.messages.length} message${opts.messages.length === 1 ? "" : "s"} in ${esc(opts.group.display_name)}</p>
      ${articles}
      ${postBox}`,
  });
}
