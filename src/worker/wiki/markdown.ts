/**
 * Markdown → HTML compiler used by the wiki on save.
 *
 * Custom extensions:
 *   - Inline `[[Page Name]]` / `[[Page Name|Label]]` wiki links resolve to
 *     `/wiki/<slug>` (kebab-cased). Unknown targets still render — the reader
 *     sees a link that 404s if the page doesn't exist yet, like MediaWiki's
 *     red-link behavior.
 *   - Block `{{embed <url>}}` on its own line. URLs in the provider allowlist
 *     (YouTube, Vimeo, Loom, CodePen) render as a responsive iframe inside
 *     `.wiki-embed`. Anything else falls back to a plain link so nothing
 *     silently vanishes. `javascript:` and other unsafe schemes are dropped.
 *
 * All output goes through marked's built-in HTML escaping. We additionally
 * sanitize image src + link href to require http(s)/relative/our-own-host
 * to defeat `javascript:` URLs in user input.
 */

import { Marked } from "marked";

/**
 * Convert `[[Page]]` / `[[Page|Label]]` to inline HTML anchors BEFORE marked
 * sees the source. We tried marked's extension API for this; the extension
 * registered cleanly under vitest in Node but never fired under the Worker
 * runtime — bracket pairs reached the HTML output untransformed. A regex
 * preprocess sidesteps marked's extension machinery entirely; marked then
 * passes the resulting inline `<a>` tag through as inline HTML.
 *
 * Targets that resolve to non-existent pages still render — readers get a
 * link that 404s, MediaWiki-style red links, until someone creates the page.
 */
function preprocessWikiLinks(md: string): string {
  // Each bracket has an OPTIONAL leading backslash because Milkdown Crepe
  // escapes opening `[` but leaves closing `]` bare (asymmetric). Treating
  // every bracket as optionally-escaped also covers the symmetric form some
  // other serializers emit.
  return md.replace(
    /\\?\[\\?\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\\?\]\\?\]/g,
    (_match, rawTarget: string, rawLabel: string | undefined) => {
      const target = rawTarget.trim();
      if (!target) return _match;
      const slug = slugify(target);
      const text = (rawLabel ?? target).trim();
      return `<a href="/wiki/${escapeAttr(slug)}" class="wiki-link" data-wiki-target="${escapeAttr(target)}">${escapeText(text)}</a>`;
    },
  );
}

const embedExtension = {
  name: "embed",
  level: "block" as const,
  start(src: string): number | undefined {
    const idx = src.indexOf("{{embed");
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src: string) {
    const match = /^\{\{embed\s+(\S+?)\s*\}\}(?:\n+|$)/.exec(src);
    if (!match) return undefined;
    return {
      type: "embed",
      raw: match[0],
      url: match[1]!.trim(),
    };
  },
  renderer(token: { url: string }) {
    return renderEmbed(token.url);
  },
};

const marked = new Marked({
  gfm: true,
  breaks: false,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.use({ extensions: [embedExtension as any] });

// Override the default link + image renderers to drop dangerous schemes.
marked.use({
  renderer: {
    link(this: unknown, opts: { href: string; title?: string | null; text: string }) {
      const href = sanitizeUrl(opts.href);
      const titleAttr = opts.title ? ` title="${escapeAttr(opts.title)}"` : "";
      if (!href) return opts.text;
      return `<a href="${escapeAttr(href)}"${titleAttr}>${opts.text}</a>`;
    },
    image(this: unknown, opts: { href: string; title?: string | null; text: string }) {
      const href = sanitizeUrl(opts.href);
      if (!href) return "";
      const titleAttr = opts.title ? ` title="${escapeAttr(opts.title)}"` : "";
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(opts.text)}"${titleAttr} loading="lazy">`;
    },
  },
});

/** Render markdown to HTML. Pure / synchronous (marked is sync when not async). */
export function compileMarkdown(markdownSource: string): string {
  // ProseMirror-based editors (Milkdown Crepe) escape `[` and `]` in their
  // serialized output because those characters open standard markdown link
  // syntax. Undo the escaping for the wiki-link pattern before processing.
  const unescaped = markdownSource.replace(
    /\\\[\\\[([^\n\]]+?)\\\]\\\]/g,
    "[[$1]]",
  );
  // Transform [[Page]] / [[Page|Label]] into inline <a> HTML BEFORE marked
  // sees the source — see preprocessWikiLinks comment for why.
  const withLinks = preprocessWikiLinks(unescaped);
  const result = marked.parse(withLinks, { async: false });
  return typeof result === "string" ? result : "";
}

/** Public helper used by the editor + page metadata: kebab-case a page title. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"`’]/g, "")          // drop quotes outright
    .replace(/[^a-z0-9]+/g, "-")     // non-alnum → hyphen
    .replace(/^-+|-+$/g, "")         // trim hyphens
    .slice(0, 80) || "untitled";
}

// ---- embeds -----------------------------------------------------------------

type EmbedSpec = {
  provider: string;
  src: string;
  /** Override the default 16:9 wrapper — e.g. CodePen wants a fixed height. */
  shape?: "fixed-height";
};

/** Provider allowlist. Each matcher returns null when the URL doesn't fit. */
const EMBED_PROVIDERS: ((url: URL) => EmbedSpec | null)[] = [
  // YouTube — watch, youtu.be, shorts. Preserves &t=N as &start=N.
  (url) => {
    let id: string | null = null;
    if (url.hostname === "youtu.be") {
      id = url.pathname.slice(1).split("/")[0] ?? null;
    } else if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.slice("/shorts/".length).split("/")[0] ?? null;
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.slice("/embed/".length).split("/")[0] ?? null;
    }
    if (!id || !/^[A-Za-z0-9_-]{6,32}$/.test(id)) return null;
    const start = parseStartSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    const src = `https://www.youtube.com/embed/${id}${start ? `?start=${start}` : ""}`;
    return { provider: "youtube", src };
  },

  // Vimeo — vimeo.com/<numeric-id>
  (url) => {
    if (!/(^|\.)vimeo\.com$/.test(url.hostname)) return null;
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    if (!/^\d{4,12}$/.test(id)) return null;
    return { provider: "vimeo", src: `https://player.vimeo.com/video/${id}` };
  },

  // Loom — loom.com/share/<id>
  (url) => {
    if (!/(^|\.)loom\.com$/.test(url.hostname)) return null;
    const m = /^\/share\/([a-z0-9]{8,64})/i.exec(url.pathname);
    if (!m) return null;
    return { provider: "loom", src: `https://www.loom.com/embed/${m[1]}` };
  },

  // CodePen — codepen.io/<user>/pen/<id>
  (url) => {
    if (!/(^|\.)codepen\.io$/.test(url.hostname)) return null;
    const m = /^\/([A-Za-z0-9_-]{1,40})\/pen\/([A-Za-z0-9]{4,16})/.exec(url.pathname);
    if (!m) return null;
    return {
      provider: "codepen",
      src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`,
      shape: "fixed-height",
    };
  },
];

function renderEmbed(rawUrl: string): string {
  const safe = sanitizeUrl(rawUrl);
  if (!safe) return ""; // unsafe scheme → drop entirely (no leak of raw input)
  let parsed: URL;
  try {
    parsed = new URL(safe, "https://example.org");
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";

  for (const match of EMBED_PROVIDERS) {
    const spec = match(parsed);
    if (!spec) continue;
    const shape = spec.shape ? ` data-shape="${escapeAttr(spec.shape)}"` : "";
    return (
      `<div class="wiki-embed" data-provider="${escapeAttr(spec.provider)}"${shape}>` +
      `<iframe src="${escapeAttr(spec.src)}" loading="lazy" ` +
      `referrerpolicy="strict-origin-when-cross-origin" ` +
      `allow="autoplay; encrypted-media; picture-in-picture; fullscreen" ` +
      `allowfullscreen></iframe>` +
      `</div>`
    );
  }

  // Unknown provider — render a plain link so the author sees something.
  return `<p><a href="${escapeAttr(safe)}" rel="nofollow noopener">${escapeText(safe)}</a></p>`;
}

function parseStartSeconds(input: string | null): number | null {
  if (!input) return null;
  // Accept either plain seconds ("42") or 1h2m3s shorthand.
  const direct = /^\d{1,6}$/.exec(input);
  if (direct) return Number(direct[0]);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(input);
  if (!m || m[0] === "") return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

// ---- helpers ----------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function sanitizeUrl(raw: string): string | null {
  if (!raw) return null;
  // Relative URLs ("/wiki/foo", "../bar", "#anchor", "foo.png") are safe.
  if (/^[#./]/.test(raw) || /^[a-z0-9_-]+(?:\.[a-z0-9]+)?$/i.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw, "https://example.org");
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    return raw;
  } catch {
    return null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
