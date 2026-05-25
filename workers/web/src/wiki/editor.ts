/**
 * Server-rendered Wiki editor + sign-in pages.
 *
 * Toast UI Editor is loaded from CDN (uicdn.toast.com) — no bundler dep.
 * The page has a single client-side script tag that wires Toast UI to the
 * JSON API. Auth is checked by the route handler before rendering this HTML.
 */

import type { PageWithCurrentVersion, VersionRow } from "./do.js";
import type { Tenant } from "@bulletinmail/db";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

type SignInOpts = {
  tenant: Tenant;
  productName: string;
  error?: string;
  notice?: string;
};

export function renderSignInPage({ tenant, productName, error, notice }: SignInOpts): string {
  return shell(productName, `Sign in — ${tenant.display_name}`, `
    <header class="masthead">
      <h1 class="wordmark">${esc(tenant.display_name)}</h1>
    </header>
    <p class="dateline">Moderator sign-in · Magic link</p>
    <h2>Sign in</h2>
    <p class="small muted">We'll email you a one-time link.</p>
    ${error ? `<div class="banner banner--alert">${esc(error)}</div>` : ""}
    ${notice ? `<div class="banner banner--ok">${esc(notice)}</div>` : ""}
    <form method="post" action="/auth/request">
      <input type="email" name="email" required autocomplete="email" placeholder="you@${esc(tenant.slug)}.org">
      <button type="submit" class="btn btn--primary">Send sign-in link</button>
    </form>
  `);
}

export function renderSignInSentPage(tenant: Tenant, productName: string, email: string): string {
  return shell(productName, `Check your inbox`, `
    <header class="masthead">
      <h1 class="wordmark">${esc(tenant.display_name)}</h1>
    </header>
    <p class="dateline">Moderator sign-in · Sent</p>
    <h2>Check your email</h2>
    <p>If <strong>${esc(email)}</strong> is a moderator for ${esc(tenant.display_name)}, we just sent a sign-in link.</p>
    <p class="small muted">The link expires in 15 minutes.</p>
  `);
}

type EditorOpts = {
  tenant: Tenant;
  productName: string;
  slug: string;
  page: PageWithCurrentVersion | null;
  versions: VersionRow[];
};

export function renderEditorPage({ tenant, productName, slug, page, versions }: EditorOpts): string {
  const title = page?.title ?? deriveTitleFromSlug(slug);
  const initialMd = page?.md_source ?? defaultBody(slug, title);
  const versionsJson = JSON.stringify(versions.map((v) => ({
    id: v.id, note: v.note, created_at: v.created_at, author_admin_id: v.author_admin_id,
  })));
  const pageId = page?.id ?? "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit ${esc(title)} — ${esc(tenant.display_name)}</title>
<link rel="stylesheet" href="/admin/styles.css">
<link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css">
<style>
  .editor-topbar {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: var(--hairline);
    background: var(--paper);
  }
  .editor-topbar input.title { width: 18rem; max-width: 18rem; min-height: 32px; }
  .editor-topbar .meta { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-muted); }
  .editor-topbar .spacer { flex: 1; }
  .editor-topbar a.view { font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); text-decoration: none; }
  .editor-topbar a.view:hover { color: var(--ink); background: transparent; }
  #status-msg { border-radius: 0; margin: 0; }
  .editor-grid { display: grid; grid-template-columns: 1fr 20rem; min-height: calc(100vh - 56px); }
  #editor { border-right: var(--hairline); }
  aside.versions { padding: var(--space-4); overflow-y: auto; background: var(--paper); }
  aside.versions h3 { font: 600 var(--text-xs)/1 var(--font-sans); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin: 0 0 var(--space-3); }
  aside.versions ul { list-style: none; padding: 0; margin: 0; }
  aside.versions li { padding: var(--space-3) 0; border-bottom: var(--hairline); font-size: var(--text-sm); }
  aside.versions li:last-child { border-bottom: 0; }
  aside.versions .ago { color: var(--ink-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  @media (max-width: 900px) { .editor-grid { grid-template-columns: 1fr; } #editor { border-right: 0; } }
</style>
</head><body>
<div class="editor-topbar">
  <input class="title field" id="page-title" value="${esc(title)}" placeholder="Page title">
  <span class="meta">/wiki/${esc(slug)}</span>
  <span class="spacer"></span>
  <a class="view" href="/wiki/${esc(slug)}">View</a>
  <button id="save-btn" class="btn btn--primary btn--small">Save</button>
</div>
<div id="status-msg" style="display:none"></div>
<main class="editor-grid">
  <div id="editor"></div>
  <aside class="versions">
    <h3>Versions</h3>
    <ul id="versions-list"></ul>
  </aside>
</main>

<script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"></script>
<script>
(() => {
  const slug = ${JSON.stringify(slug)};
  const pageId = ${JSON.stringify(pageId)};
  const initialMd = ${JSON.stringify(initialMd)};
  const versions = ${versionsJson};
  const productName = ${JSON.stringify(productName)};

  const editor = new toastui.Editor({
    el: document.getElementById('editor'),
    height: 'calc(100vh - 56px)',
    initialEditType: 'markdown',
    previewStyle: 'tab',
    initialValue: initialMd,
    usageStatistics: false,
    hooks: {
      addImageBlobHook: async (blob, callback) => {
        const fd = new FormData();
        fd.append('image', blob, blob.name || 'image');
        try {
          const res = await fetch('/api/wiki/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
          if (!res.ok) throw new Error('upload failed: ' + res.status);
          const json = await res.json();
          callback(json.url, blob.name || '');
        } catch (err) {
          showStatus('err', 'Image upload failed: ' + err.message);
        }
      }
    }
  });

  function showStatus(kind, text) {
    const el = document.getElementById('status-msg');
    el.className = 'banner ' + kind;
    el.textContent = text;
    el.style.display = '';
    if (kind === 'ok') setTimeout(() => { el.style.display = 'none'; }, 2500);
  }

  document.getElementById('save-btn').addEventListener('click', async () => {
    const title = document.getElementById('page-title').value.trim() || ${JSON.stringify(deriveTitleFromSlug(slug))};
    const md = editor.getMarkdown();
    try {
      const res = await fetch('/api/wiki/' + encodeURIComponent(slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title, mdSource: md }),
      });
      if (!res.ok) throw new Error('save failed: ' + res.status);
      const json = await res.json();
      showStatus('ok', 'Saved version ' + json.versionId.slice(0, 8));
      // Refresh version list.
      const v = await (await fetch('/api/wiki/' + encodeURIComponent(slug) + '/versions', { credentials: 'same-origin' })).json();
      renderVersions(v.versions || []);
    } catch (err) {
      showStatus('err', err.message);
    }
  });

  function renderVersions(list) {
    const ul = document.getElementById('versions-list');
    if (!list.length) { ul.innerHTML = '<li class="ago">No history yet.</li>'; return; }
    ul.innerHTML = '';
    for (const v of list) {
      const li = document.createElement('li');
      const dt = new Date(v.created_at);
      li.innerHTML =
        '<div>' + (v.note ? escapeHtml(v.note) : '<em>edit</em>') + '</div>' +
        '<div class="ago">' + dt.toLocaleString() + '</div>';
      const btn = document.createElement('button');
      btn.textContent = 'Revert to this';
      btn.className = 'btn btn--small';
      btn.style.marginTop = '0.4rem';
      btn.addEventListener('click', async () => {
        if (!confirm('Revert page to this version? A new version will be created carrying the older content.')) return;
        try {
          const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/revert/' + encodeURIComponent(v.id), {
            method: 'POST', credentials: 'same-origin',
          });
          if (!res.ok) throw new Error('revert failed: ' + res.status);
          location.reload();
        } catch (err) { showStatus('err', err.message); }
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';'); }
  renderVersions(versions);
})();
</script>
</body></html>`;
}

function defaultBody(slug: string, title: string): string {
  if (slug === "index") {
    return `# ${title}\n\nWelcome to the wiki. Use **[[Page Name]]** to create or link to other pages — they'll show up as red links until you create them.\n\n## Getting started\n\n- Edit this page to introduce your organization.\n- Link out: [[About]], [[Contact]], [[Statement of Faith]].\n- Drag images directly into the editor — they upload automatically.\n`;
  }
  return `# ${title}\n\nWrite something here. Link back to the **[[Index]]** when done.\n`;
}

function deriveTitleFromSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function shell(productName: string, pageTitle: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)} — ${esc(productName)}</title>
<link rel="stylesheet" href="/admin/styles.css">
</head><body><main class="signin-shell">${body}</main></body></html>`;
}

export { deriveTitleFromSlug };
