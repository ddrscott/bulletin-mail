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
  const initialVisibility = page?.visibility === "private" ? "private" : "public";
  // md_source is included so Preview can swap into the editor without an
  // extra round-trip. Capped at 50 most recent versions to keep payload sane.
  const versionsJson = JSON.stringify(versions.slice(0, 50).map((v) => ({
    id: v.id,
    note: v.note,
    created_at: v.created_at,
    author_admin_id: v.author_admin_id,
    md_source: v.md_source,
  })));
  const pageId = page?.id ?? "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit ${esc(title)} — ${esc(tenant.display_name)}</title>
<link rel="stylesheet" href="/admin/styles.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@milkdown/crepe@7.21.1/lib/theme/common/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@milkdown/crepe@7.21.1/lib/theme/frame/style.css">
<style>
  .editor-topbar {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: var(--hairline);
    background: var(--paper);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .editor-topbar > * { flex-shrink: 0; }
  .editor-topbar input.title { width: 18rem; max-width: 18rem; min-height: 32px; flex-shrink: 1; min-width: 8rem; }
  .editor-topbar .meta { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-muted); }
  .editor-topbar .spacer { flex: 1; }
  .editor-topbar a.view { font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); text-decoration: none; }
  .editor-topbar a.view:hover { color: var(--ink); background: transparent; }
  .visibility-toggle { display: inline-flex; border: 1px solid var(--rule); border-radius: 999px; padding: 2px; gap: 2px; }
  .visibility-toggle label { font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted); cursor: pointer; padding: 4px 10px; border-radius: 999px; line-height: 1; }
  .visibility-toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .visibility-toggle input:checked + label { background: var(--ink); color: var(--paper); }
  .visibility-toggle input[value="private"]:checked + label { background: var(--alert); color: var(--paper); }
  .history-toggle { font: 600 var(--text-xs) var(--font-sans); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); background: transparent; border: 1px solid var(--rule); padding: 6px 10px; border-radius: 4px; cursor: pointer; }
  .history-toggle:hover { color: var(--ink); border-color: var(--ink); }
  .history-toggle[aria-expanded="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .preview-banner { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); background: var(--paper-2); border-bottom: var(--hairline); font-size: var(--text-sm); }
  .preview-banner strong { font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--alert); }
  .preview-banner .spacer { flex: 1; }
  aside.versions { display: none; }
  .editor-grid--with-versions aside.versions { display: block; }
  /* minmax(0, 1fr) lets the editor column shrink below its content's
     intrinsic width. Without it, the Toast UI toolbar (which has its
     own overflow-x: auto) was pushing the grid column wider than the
     viewport, causing horizontal scroll on the whole body. */
  .editor-grid--with-versions { grid-template-columns: minmax(0, 1fr) 20rem; }
  aside.versions li { cursor: default; }
  aside.versions li.version-row { padding: var(--space-3) 0; }
  aside.versions li.version-row button.preview-btn { font: 600 var(--text-xs) var(--font-sans); text-transform: uppercase; letter-spacing: 0.05em; background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--ink); }
  aside.versions li.version-row button.preview-btn:hover { text-decoration: underline; }
  aside.versions li.version-row.active { background: var(--paper-2); padding-left: var(--space-3); margin-left: calc(-1 * var(--space-3)); }
  #status-msg { border-radius: 0; margin: 0; }
  /* Single-column by default (versions panel hidden); adds the 20rem
     right column only when .editor-grid--with-versions is applied.
     Same minmax(0, ...) trick to clamp the column to viewport width. */
  .editor-grid { display: grid; grid-template-columns: minmax(0, 1fr); min-height: calc(100vh - 56px); }
  #editor { border-right: var(--hairline); min-width: 0; }
  aside.versions { padding: var(--space-4); overflow-y: auto; background: var(--paper); }
  aside.versions h3 { font: 600 var(--text-xs)/1 var(--font-sans); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin: 0 0 var(--space-3); }
  aside.versions ul { list-style: none; padding: 0; margin: 0; }
  aside.versions li { padding: var(--space-3) 0; border-bottom: var(--hairline); font-size: var(--text-sm); }
  aside.versions li:last-child { border-bottom: 0; }
  aside.versions .ago { color: var(--ink-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
  @media (max-width: 900px) { .editor-grid--with-versions { grid-template-columns: minmax(0, 1fr); } #editor { border-right: 0; } }
  /* Final safety belt — keep the body from acquiring its own horizontal
     scroll if anything inside still overflows. The Toast UI toolbar has
     its own overflow-x: auto so it scrolls independently. */
  html, body { overflow-x: hidden; max-width: 100vw; }

  /* Mobile editor tweaks. At narrow viewports the topbar's horizontal
   * scroll buries the Save button off the right edge, and Milkdown's
   * default 60px×120px ProseMirror padding leaves almost no content
   * width on a 412px screen. Wrap the topbar, make Save full-width
   * + sticky to the bottom of the topbar row, and shrink the
   * ProseMirror prose padding to something usable on phones. */
  @media (max-width: 640px) {
    .editor-topbar { flex-wrap: wrap; overflow-x: visible; }
    .editor-topbar .spacer { display: none; }
    .editor-topbar input.title { width: 100%; max-width: 100%; }
    .editor-topbar #save-btn {
      order: 99; flex: 1 1 100%; min-height: 40px;
      font-size: var(--text-sm); font-weight: 700;
    }
    .milkdown .ProseMirror { padding: 24px 16px; }
  }
</style>
</head><body>
<div class="editor-topbar">
  <input class="title field" id="page-title" value="${esc(title)}" placeholder="Page title">
  <span class="meta">/wiki/${esc(slug)}</span>
  <span class="spacer"></span>
  <div class="visibility-toggle" role="radiogroup" aria-label="Page visibility">
    <input type="radio" name="visibility" id="vis-public" value="public"${initialVisibility === "public" ? " checked" : ""}>
    <label for="vis-public" title="Anyone with the URL can read this page">Public</label>
    <input type="radio" name="visibility" id="vis-private" value="private"${initialVisibility === "private" ? " checked" : ""}>
    <label for="vis-private" title="Only your team (admins + moderators) can read this page">Private</label>
  </div>
  <button id="history-btn" class="history-toggle" type="button" aria-expanded="false" aria-controls="versions-panel">History</button>
  <a class="view" href="/wiki/${esc(slug)}">View</a>
  <button id="save-btn" class="btn btn--primary btn--small">Save</button>
</div>
<div id="status-msg" style="display:none"></div>
<div id="preview-banner" class="preview-banner" style="display:none">
  <strong>Previewing version</strong>
  <span id="preview-meta"></span>
  <span class="spacer"></span>
  <button id="revert-btn" class="btn btn--alert btn--small" type="button">Revert to this</button>
  <button id="cancel-preview-btn" class="btn btn--small" type="button">Cancel preview</button>
</div>
<main id="editor-grid" class="editor-grid">
  <div id="editor"></div>
  <aside id="versions-panel" class="versions">
    <h3>Versions</h3>
    <ul id="versions-list"></ul>
  </aside>
</main>

<script type="module">
  // Milkdown Crepe — modern markdown ↔ rich-text editor, mobile-friendly,
  // CDN-loadable via esm.sh. The Crepe preset bundles a sensible set of
  // features (toolbar, slash-menu, image-block, code-mirror, table, etc.)
  // so we don't have to wire them up by hand. https://milkdown.dev/
  // The bundle-deps query flag tells esm.sh to inline Crepe dependencies
  // (codemirror, prosemirror, etc.) into one module instead of resolving
  // them as separate ESM imports. Without it, codemirror 6.x on esm.sh
  // does not re-export basicSetup the way Crepe expects, and the editor
  // never mounts.
  import { Crepe } from "https://esm.sh/@milkdown/crepe@7.21.1?bundle-deps";

  const slug = ${JSON.stringify(slug)};
  const pageId = ${JSON.stringify(pageId)};
  const initialMd = ${JSON.stringify(initialMd)};
  const versions = ${versionsJson};
  const productName = ${JSON.stringify(productName)};

  const editorRoot = document.getElementById('editor');

  // Crepe doesn't expose a setMarkdown — to swap content (preview / cancel
  // preview / revert) we destroy and recreate the editor with new defaults.
  // Slower than an in-place replace, but a clean reset and avoids ProseMirror
  // state divergence. The editor root element is reused.
  async function buildCrepe(defaultMd) {
    const c = new Crepe({
      root: editorRoot,
      defaultValue: defaultMd,
      featureConfigs: {
        'image-block': {
          onUpload: async (file) => {
            const fd = new FormData();
            fd.append('image', file);
            const res = await fetch('/api/wiki/upload', {
              method: 'POST', body: fd, credentials: 'same-origin',
            });
            if (!res.ok) throw new Error('upload failed: ' + res.status);
            const json = await res.json();
            return json.url;
          },
        },
      },
    });
    await c.create();
    return c;
  }

  let crepe;
  try {
    crepe = await buildCrepe(initialMd);
  } catch (err) {
    editorRoot.innerHTML = '<div style="padding:1rem;color:var(--alert)">Editor failed to load: ' +
      (err && err.message ? err.message : String(err)) + '</div>';
    throw err;
  }

  async function setEditorMarkdown(md) {
    await crepe.destroy();
    editorRoot.innerHTML = '';
    crepe = await buildCrepe(md);
  }

  function getEditorMarkdown() {
    return crepe.getMarkdown();
  }

  function showStatus(kind, text) {
    const el = document.getElementById('status-msg');
    el.className = 'banner ' + kind;
    el.textContent = text;
    el.style.display = '';
    if (kind === 'ok') setTimeout(() => { el.style.display = 'none'; }, 2500);
  }

  // Preview state — when set, the editor is showing an older version
  // read-only. workingMd holds the user's in-progress content so Cancel
  // can restore it without a round-trip.
  let previewing = null;       // { id, created_at } when active, null otherwise
  let workingMd = initialMd;

  const grid = document.getElementById('editor-grid');
  const historyBtn = document.getElementById('history-btn');
  const previewBanner = document.getElementById('preview-banner');
  const previewMeta = document.getElementById('preview-meta');
  const revertBtn = document.getElementById('revert-btn');
  const cancelPreviewBtn = document.getElementById('cancel-preview-btn');
  const saveBtn = document.getElementById('save-btn');

  historyBtn.addEventListener('click', () => {
    const open = grid.classList.toggle('editor-grid--with-versions');
    historyBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  async function enterPreview(v) {
    // Snapshot current edits the first time we enter preview so Cancel
    // restores them. Subsequent version clicks just swap content.
    if (!previewing) workingMd = getEditorMarkdown();
    previewing = v;
    await setEditorMarkdown(v.md_source || '');
    saveBtn.disabled = true;
    previewMeta.textContent = ' from ' + new Date(v.created_at).toLocaleString() +
      (v.note ? ' · ' + v.note : '');
    previewBanner.style.display = '';
    for (const row of document.querySelectorAll('aside.versions li.version-row')) {
      row.classList.toggle('active', row.dataset.versionId === v.id);
    }
  }

  async function exitPreview() {
    if (!previewing) return;
    previewing = null;
    await setEditorMarkdown(workingMd);
    saveBtn.disabled = false;
    previewBanner.style.display = 'none';
    for (const row of document.querySelectorAll('aside.versions li.version-row.active')) {
      row.classList.remove('active');
    }
  }

  cancelPreviewBtn.addEventListener('click', exitPreview);

  revertBtn.addEventListener('click', async () => {
    if (!previewing) return;
    if (!confirm('Revert page to this version? A new version row is created carrying the older content — history stays intact.')) return;
    try {
      const res = await fetch('/api/wiki/' + encodeURIComponent(slug) + '/revert/' + encodeURIComponent(previewing.id), {
        method: 'POST', credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('revert failed: ' + res.status);
      location.reload();
    } catch (err) { showStatus('err', err.message); }
  });

  saveBtn.addEventListener('click', async () => {
    if (previewing) return; // disabled while previewing
    const title = document.getElementById('page-title').value.trim() || ${JSON.stringify(deriveTitleFromSlug(slug))};
    const md = getEditorMarkdown();
    const visibility = (document.querySelector('input[name="visibility"]:checked') || {}).value || 'public';
    try {
      const res = await fetch('/api/wiki/' + encodeURIComponent(slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title, mdSource: md, visibility }),
      });
      if (!res.ok) throw new Error('save failed: ' + res.status);
      const json = await res.json();
      showStatus('ok', 'Saved version ' + json.versionId.slice(0, 8));
      workingMd = md;
      // Refresh version list (with md_source for preview).
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
      li.className = 'version-row';
      li.dataset.versionId = v.id;
      const dt = new Date(v.created_at);
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'preview-btn';
      previewBtn.textContent = v.note ? v.note : 'edit';
      previewBtn.addEventListener('click', () => enterPreview(v));
      const ago = document.createElement('div');
      ago.className = 'ago';
      ago.textContent = dt.toLocaleString();
      li.appendChild(previewBtn);
      li.appendChild(ago);
      ul.appendChild(li);
    }
  }
  renderVersions(versions);
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
