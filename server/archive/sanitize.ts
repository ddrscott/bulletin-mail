/**
 * Email-body sanitization for the archive.
 *
 * Email HTML is the most hostile HTML there is. Policy (task acceptance +
 * PRD §13 privacy row):
 *
 *   - script / style / iframe / object / embed / form / link / meta / base
 *     are removed outright (content too, for script+style).
 *   - Every on* event-handler attribute is stripped.
 *   - href/src accept only http(s), mailto, and (for images) our own
 *     attachment rewrites. javascript:, data:, vbscript: etc. are dropped.
 *   - External images are BLOCKED by default (tracking pixels): the src is
 *     removed and the element gets a class so CSS can show a placeholder.
 *     `cid:` inline images are rewritten to our auth-checked attachment
 *     route when the Content-ID maps to a stored attachment.
 *   - target/rel are normalized on links (noopener noreferrer).
 *
 * Implementation: HTMLRewriter — the Workers-native streaming HTML parser.
 * No regex-over-HTML, no third-party sanitizer dependency (free-tier
 * friendly, and regex sanitizers are how you get XSS'd). The pure policy
 * functions are exported for unit tests, which run in plain Node where
 * HTMLRewriter doesn't exist.
 */

/** Elements removed together with their content. */
const REMOVE_WITH_CONTENT = ["script", "style", "title", "head"];

/** Elements removed but whose children are kept. */
const REMOVE_KEEP_CONTENT = [
  "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea",
  "link", "meta", "base", "template", "slot", "portal", "dialog",
  "audio", "video", "source", "track", "svg", "math", "canvas", "noscript",
];

const SAFE_URL_RE = /^(?:https?:|mailto:)/i;

/** True if an attribute name is an event handler (onclick, onerror, ...). */
export function isEventHandlerAttr(name: string): boolean {
  return /^on/i.test(name);
}

/**
 * Validate a URL attribute value. Allows http(s) + mailto and bare
 * relative/fragment references; rejects every other scheme (javascript:,
 * data:, vbscript:, ...). Scheme detection tolerates the whitespace and
 * control characters browsers strip before parsing.
 */
export function isSafeUrl(value: string): boolean {
  const cleaned = value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  const colon = cleaned.indexOf(":");
  if (colon === -1) return true; // relative URL or fragment — schemeless
  const slash = cleaned.indexOf("/");
  const hash = cleaned.indexOf("#");
  const query = cleaned.indexOf("?");
  // A ':' after '/', '#' or '?' is not a scheme separator ("./a:b").
  for (const idx of [slash, hash, query]) {
    if (idx !== -1 && idx < colon) return true;
  }
  return SAFE_URL_RE.test(cleaned);
}

/**
 * Decide what happens to an <img> src.
 *   - `cid:<id>` with a known attachment  → rewrite to the attachment URL
 *   - anything else (external, data:, unknown cid) → blocked
 * Blocking external images by default kills tracking pixels; a future
 * "load remote images" toggle can relax this per user.
 */
export function resolveImgSrc(
  src: string,
  cidMap: ReadonlyMap<string, string>,
): { kind: "rewrite"; url: string } | { kind: "blocked" } {
  const m = /^cid:(.+)$/i.exec(src.trim());
  if (m) {
    const key = m[1]!.replace(/^<|>$/g, "").toLowerCase();
    const url = cidMap.get(key);
    if (url) return { kind: "rewrite", url };
  }
  return { kind: "blocked" };
}

/** Normalize a Content-ID header value into the cidMap key form. */
export function normalizeContentId(contentId: string): string {
  return contentId.replace(/^<|>$/g, "").trim().toLowerCase();
}

/**
 * Sanitize an email HTML body. `cidMap` maps normalized Content-IDs to
 * attachment-serving URLs for inline-image rewriting.
 *
 * Requires the Workers runtime (HTMLRewriter). Callers in tests should
 * exercise the exported policy functions instead.
 */
export async function sanitizeEmailHtml(
  html: string,
  cidMap: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  const rewriter = new HTMLRewriter();

  for (const tag of REMOVE_WITH_CONTENT) {
    rewriter.on(tag, {
      element(el) { el.remove(); },
    });
  }
  for (const tag of REMOVE_KEEP_CONTENT) {
    rewriter.on(tag, {
      element(el) { el.removeAndKeepContent(); },
    });
  }

  // Generic attribute scrub on every remaining element.
  rewriter.on("*", {
    element(el) {
      const toRemove: string[] = [];
      // workers-types models attributes as IterableIterator<string[]> — pull
      // the pair out defensively.
      for (const attr of el.attributes) {
        const name = attr[0] ?? "";
        const value = attr[1] ?? "";
        if (name === "") continue;
        if (isEventHandlerAttr(name)) { toRemove.push(name); continue; }
        if ((name === "href" || name === "xlink:href" || name === "action" || name === "formaction" || name === "srcset" || name === "background") && !isSafeUrl(value)) {
          toRemove.push(name);
        }
      }
      for (const name of toRemove) el.removeAttribute(name);
    },
  });

  rewriter.on("a", {
    element(el) {
      if (el.getAttribute("href")) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    },
  });

  rewriter.on("img", {
    element(el) {
      const src = el.getAttribute("src") ?? "";
      const resolved = resolveImgSrc(src, cidMap);
      if (resolved.kind === "rewrite") {
        el.setAttribute("src", resolved.url);
        el.removeAttribute("loading");
        el.setAttribute("loading", "lazy");
      } else {
        el.removeAttribute("src");
        el.removeAttribute("srcset");
        el.setAttribute("class", "blocked-remote-img");
        if (!el.getAttribute("alt")) el.setAttribute("alt", "[remote image blocked]");
      }
    },
  });

  const res = rewriter.transform(new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  return res.text();
}

/**
 * Render a text/plain email body as HTML: escape, autolink http(s) URLs,
 * mark quoted (`>`-prefixed) lines, preserve line breaks. Pure — unit
 * testable in Node.
 */
export function renderPlainTextBody(text: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const quoted = /^\s*>/.test(line);
    const escaped = esc(line).replace(
      /\bhttps?:\/\/[^\s<>"']+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
    );
    out.push(quoted ? `<span class="quote">${escaped}</span>` : escaped);
  }
  return `<div class="plain-body">${out.join("<br>\n")}</div>`;
}
