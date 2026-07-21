/**
 * Unified search page (community hub 4/5) — one query box over the mail
 * archive and the wiki, served at GET /search on the tenant host.
 *
 * The route handler (archive/routes.ts) embeds the query and runs the
 * tenant-filtered Vectorize lookup; this module holds the pure parts:
 * turning raw matches into viewer-visible result items, and rendering.
 *
 * Visibility rules, applied AFTER the vector query (Vectorize only scopes
 * by tenant):
 *   - message hits are re-read from D1 and pass through the same
 *     canViewGroup() the archive browser uses — a stale vector can never
 *     leak a message the viewer couldn't open anyway.
 *   - wiki hits render from vector metadata; private pages only for
 *     admins/moderators (mirrors renderWikiPage's gate).
 */

import type { Tenant } from "@bulletinmail/db";
import type { SearchMatch } from "@bulletinmail/shared";
import { relativeTime, shell } from "./render.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Lucide "mail" — type badge for archive-thread results.
const MAIL_SVG =
  `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="List thread" role="img"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;

// Lucide "file-text" — type badge for wiki-page results.
const FILE_TEXT_SVG =
  `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Wiki page" role="img"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;

export type SearchResultItem = {
  kind: "message" | "wiki";
  title: string;
  snippet: string;
  href: string;
  score: number;
  /** messages: group display name; wiki: "Wiki". */
  context: string;
  /** messages only — received_at for the "…ago" label. */
  when?: number;
};

/**
 * Convert a `wiki:` vector match into a result item, or null when the
 * viewer may not see it. Pure — exported for tests.
 */
export function wikiMatchToItem(
  match: SearchMatch,
  viewerIsAdmin: boolean,
): SearchResultItem | null {
  const md = match.metadata;
  if (!md || md.type !== "wiki" || typeof md.slug !== "string") return null;
  if (md.visibility === "private" && !viewerIsAdmin) return null;
  return {
    kind: "wiki",
    title: typeof md.title === "string" && md.title ? md.title : md.slug,
    snippet: typeof md.snippet === "string" ? md.snippet : "",
    href: `/wiki/${md.slug}`,
    score: match.score,
    context: "Wiki",
  };
}

export function renderSearchPage(opts: {
  tenant: Tenant;
  productName: string;
  viewerLabel: string;
  query: string;
  /** null = the vector lookup itself failed (show an error state). */
  items: SearchResultItem[] | null;
}): string {
  const q = opts.query.trim();

  let resultsHtml: string;
  if (opts.items === null) {
    resultsHtml = `<div class="banner err">Search is temporarily unavailable. Try again in a minute.</div>`;
  } else if (q === "") {
    resultsHtml = `<p class="empty">Type a few words above — search covers every list thread and wiki page you can see.</p>`;
  } else if (opts.items.length === 0) {
    resultsHtml = `<p class="empty">No results for &ldquo;${esc(q)}&rdquo;.</p>`;
  } else {
    resultsHtml = `<ul class="rowlist">${opts.items
      .map(
        (r) => `<li>
        <h2 class="row-title"><a href="${esc(r.href)}">${esc(r.title)}</a></h2>
        ${r.snippet ? `<p class="row-desc">${esc(r.snippet)}</p>` : ""}
        <p class="row-meta">${r.kind === "wiki" ? FILE_TEXT_SVG : MAIL_SVG} ${esc(r.context)}${r.when ? `<span class="sep">·</span>${esc(relativeTime(r.when))}` : ""}</p>
      </li>`,
      )
      .join("")}</ul>`;
  }

  return shell({
    tenant: opts.tenant,
    productName: opts.productName,
    title: q ? `Search: ${q}` : "Search",
    crumbs: [{ label: "Archive", href: "/archive" }, { label: "Search" }],
    viewerLabel: opts.viewerLabel,
    body: `<h1>Search</h1>
      <p class="lede">One search over list threads and wiki pages.</p>
      <form method="get" action="/search" style="display:flex;gap:var(--space-2);margin:0 0 var(--space-6)">
        <input type="search" name="q" value="${esc(q)}" placeholder="Search threads and wiki pages" aria-label="Search query" maxlength="200" autofocus style="font:inherit;flex:1;padding:var(--space-2) var(--space-3);border:1px solid var(--rule);border-radius:4px;background:transparent;color:var(--ink)">
        <button type="submit" style="font:inherit;padding:var(--space-2) var(--space-4);border:0;border-radius:4px;background:var(--ink);color:var(--paper);cursor:pointer">Search</button>
      </form>
      ${resultsHtml}`,
  });
}
