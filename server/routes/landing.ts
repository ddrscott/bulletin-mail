/**
 * Landing page — apex-only marketing splash, server-rendered.
 *
 *   GET /   broadsheet hero + three reassurances + primary CTA → /contact
 *
 * Lives in the Worker (not Astro) because the apex root is owned by Hono
 * post-consolidation. Astro emits docs under /docs/* and the Worker's
 * [assets] binding serves them; the apex `/` is handled here.
 *
 * Inline CSS — the page is small and self-contained, doesn't share Astro's
 * bundled stylesheet (which lives under /docs/_astro/). Restating tokens
 * locally keeps the page paintable without a network round-trip to the
 * docs CSS bundle. Stays in sync with packages/shared/design/* by convention.
 */

import type { Hono } from "hono";
import { classifyHost } from "@bulletinmail/shared";
import type { AppVariables, Env } from "../types.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function mountLanding(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
): void {
  app.get("/", (c, next) => {
    const host = c.req.header("Host") ?? "";
    if (classifyHost(host, c.var.config).kind !== "apex") return next();
    return c.html(landingPage(c.var.config.productName));
  });
}

function landingPage(productName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(productName)}</title>
  <meta name="description" content="Mailing lists that just work — multi-tenant, open source, runs on Cloudflare.">
  <link rel="shortcut icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:title" content="${escapeHtml(productName)}">
  <meta property="og:type" content="website">
  <meta property="og:description" content="Mailing lists that just work.">
  <style>
    :root {
      color-scheme: light;
      --paper: #FAF8F2;
      --paper-2: #F2EFE6;
      --ink: #1A1814;
      --ink-muted: #6B6B66;
      --rule: #D6D2C7;
      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
      --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
      --space-9: 80px;
      --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-serif: "Source Serif 4", ui-serif, Georgia, serif;
      --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.55 var(--font-sans);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    .app-shell { max-width: 980px; margin: 0 auto; padding: 0 var(--space-5); }
    @media (min-width: 900px) { .app-shell { padding: 0 var(--space-7); } }
    @media (min-width: 1200px) { .app-shell { padding: 0 var(--space-8); } }
    a { color: var(--ink); text-underline-offset: 2px; }
    a:hover { background: var(--paper-2); }

    /* Masthead */
    .masthead {
      display: flex; align-items: center; justify-content: space-between;
      gap: var(--space-4); padding: var(--space-5) 0 var(--space-2);
      border-bottom: 2px solid var(--ink);
    }
    .wordmark {
      font-family: var(--font-serif); font-weight: 600; font-size: 32px;
      line-height: 1; letter-spacing: -0.01em; margin: 0;
    }
    .wordmark a { color: inherit; text-decoration: none; }
    .wordmark a:hover { background: transparent; }
    .masthead-nav { display: flex; gap: var(--space-4); font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .masthead-nav a { color: var(--ink-muted); text-decoration: none; }
    .masthead-nav a:hover { color: var(--ink); background: transparent; }

    /* Dateline */
    .dateline {
      font-family: var(--font-sans); font-size: 13px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted);
      padding: var(--space-2) 0 var(--space-6); margin: 0;
    }
    .dateline .sep { padding: 0 var(--space-2); color: var(--rule); }

    /* Broadsheet grid */
    .broadsheet-hero { margin: var(--space-6) 0 var(--space-7); }
    .broadsheet {
      display: grid; grid-template-columns: 1fr; gap: var(--space-5);
      align-items: start;
    }
    @media (min-width: 720px) {
      .broadsheet { grid-template-columns: 1fr 1px 1fr; gap: var(--space-6); }
      .broadsheet > .rule { background: var(--rule); height: 100%; }
    }
    .broadsheet--triple { grid-template-columns: 1fr; gap: var(--space-5); margin-bottom: var(--space-7); }
    @media (min-width: 720px) {
      .broadsheet--triple {
        grid-template-columns: 1fr 1px 1fr 1px 1fr;
        gap: var(--space-5);
      }
    }
    .broadsheet--triple > .rule { background: var(--rule); height: 100%; }
    .broadsheet-hero h2 {
      font-family: var(--font-serif); font-weight: 600; font-size: 64px;
      line-height: 1; letter-spacing: -0.02em; margin: 0;
    }
    @media (max-width: 900px) { .broadsheet-hero h2 { font-size: 44px; } }
    .lede {
      font-family: var(--font-serif); font-size: 20px; line-height: 1.4;
      font-style: italic; color: var(--ink); max-width: 56ch;
      margin: 0 0 var(--space-5);
    }
    .smallcaps {
      font-family: var(--font-sans); font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted);
      margin: 0 0 var(--space-2);
    }
    p { margin: 0 0 var(--space-4); }

    /* Button */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: var(--space-2); font: 500 14px/1 var(--font-sans);
      padding: var(--space-2) var(--space-4); min-height: 36px;
      border: 1px solid var(--ink); background: var(--paper); color: var(--ink);
      border-radius: 2px; cursor: pointer; text-decoration: none;
      transition: background-color 120ms, color 120ms;
    }
    .btn.btn--primary { background: var(--ink); color: var(--paper); }
    .btn.btn--primary:hover { background: var(--paper); color: var(--ink); }

    /* Colophon */
    .colophon {
      border-top: 1px solid var(--rule);
      padding: var(--space-5) 0 var(--space-7);
      font-family: var(--font-mono); font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ink-muted);
    }
    .colophon p { margin: 0 0 var(--space-2); }
    .colophon a { color: var(--ink-muted); text-decoration: underline; }
    .colophon a:hover { color: var(--ink); background: transparent; }
  </style>
</head>
<body>
<div class="app-shell">
  <header class="masthead">
    <h1 class="wordmark"><a href="/">${escapeHtml(productName)}</a></h1>
    <nav class="masthead-nav">
      <a href="/docs/">Docs</a>
      <a href="/contact">Contact</a>
      <a href="https://github.com/ddrscott/bulletin-mail">GitHub</a>
    </nav>
  </header>

  <p class="dateline">Discussion groups in your inbox.</p>

  <section class="broadsheet-hero">
    <div class="broadsheet">
      <div>
        <h2>Mailing lists that just work.</h2>
      </div>
      <div class="rule"></div>
      <div>
        <p class="lede">
          A volunteer church administrator should be able to create a list in
          60 seconds and have the next email a pastor sends reach every member
          — threaded correctly, with one-click unsubscribe.
        </p>
        <p>
          <a href="/contact" class="btn btn--primary">Notify me when the hosted service launches →</a>
        </p>
      </div>
    </div>
  </section>

  <div class="broadsheet broadsheet--triple">
    <div>
      <p class="smallcaps">Lands in the inbox</p>
      <p>Configured the way the big providers configure themselves, so your messages don't end up in spam.</p>
    </div>
    <div class="rule"></div>
    <div>
      <p class="smallcaps">One-click unsubscribe</p>
      <p>Every message has a working unsubscribe link, so anyone who's done can leave on their own.</p>
    </div>
    <div class="rule"></div>
    <div>
      <p class="smallcaps">Members-only by default</p>
      <p>The archive is private unless you make it public, and subscriber addresses are never published.</p>
    </div>
  </div>

  <footer class="colophon">
    <p>Open source · AGPL-3.0 · Built on Cloudflare</p>
    <p>Running your own instance? <a href="/docs/how-to/self-host/">Self-hosting guide</a> · <a href="https://github.com/ddrscott/bulletin-mail">GitHub</a></p>
    <p><a href="/docs/legal/terms/">Terms</a> · <a href="/docs/legal/privacy/">Privacy</a></p>
  </footer>
</div>
</body>
</html>`;
}
