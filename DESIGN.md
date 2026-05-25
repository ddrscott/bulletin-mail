# DESIGN

> The visual identity for BulletinMail — across docs, admin UI, marketing pages, and any future surface. One spec, two implementations (Astro/Starlight + plain HTML/TS), zero drift.

## 1. The thesis

BulletinMail is mail — the most retro protocol still in daily use — built on the most modern edge runtime. The design honors both: it looks like a **broadsheet newspaper** printed on a Braun control panel, served by Craigslist, mastered at Teenage Engineering. The voice is **archival**, not playful; **functional**, not decorative; **legible**, not loud.

Email is older than the web. The interface should feel like it knows that — and respect it.

## 2. The four influences

We pull one thing from each, then we stop.

| Influence              | What we take                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Dieter Rams / Braun**| "Less, but better." Honest materials. Functional restraint. Status indicators as discrete colored marks.            |
| **Teenage Engineering**| Pixel precision. Numerical labels (`v1.0`, `VOL. I`). One bold accent on a neutral panel. Constraint as personality.|
| **Craigslist**         | No chrome. Plain HTML semantics. Information density. The text *is* the interface — no decorative scaffolding.       |
| **Broadsheet print**   | Masthead serif. Dateline. Column rules. Section labels in small caps. Classifieds-style tabular data. Dropcaps.      |

What we explicitly do **not** take: glassmorphism, gradients, soft shadows, rounded bubbles, bright multi-color palettes, illustration, animation as decoration, emoji as iconography.

## 3. The masthead

Every surface — docs landing, admin shell, sign-in, even error pages — opens with the same masthead structure. This is the load-bearing identity element. If everything else were stripped away, the masthead alone should identify the system.

```
┌──────────────────────────────────────────────────────────────────┐
│ THE BULLETIN  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  VOL. I · 2026     │
│ MONDAY · MAY 25 · MAILING LISTS THAT JUST WORK · SINCE 2026      │
└──────────────────────────────────────────────────────────────────┘
```

Composition:
- **Wordmark** in serif, large, tracking tight. `THE BULLETIN` for marketing/docs; `BULLETINMAIL · ADMIN` for the admin app.
- **Rule** — an indigo bar (or a Unicode block run) carrying the eye from wordmark to volume marker.
- **Volume marker** — `VOL. I · 2026` in mono, right-aligned. Mono signals "this is a system value, not a slogan."
- **Dateline** in small caps, all-caps, letter-spaced. On admin pages, the dateline becomes a breadcrumb: `LIST · ANNOUNCEMENTS · MEMBERS`.

## 4. Color system

One accent. One semantic alert color. Everything else, neutral and warm — newsprint, not LCD.

### Tokens

```css
:root {
  /* Neutrals — warm, paper-aged */
  --paper:       #FAF8F2;   /* page background; aged newsprint */
  --paper-2:     #F2EFE6;   /* subtle alternation (table stripe, panel) */
  --ink:         #1A1814;   /* body text; warm near-black */
  --ink-muted:   #6B6B66;   /* metadata, captions, table headers */
  --rule:        #D4D0C4;   /* column rules, hairlines, borders */
  --rule-strong: #1A1814;   /* masthead rules, dividers */

  /* Accent — Indigo Stamp */
  --indigo:      #1E2A78;   /* links, primary buttons, active states */
  --indigo-ink:  #FAF8F2;   /* text on indigo (= paper) */
  --indigo-tint: #E7E9F2;   /* hover backgrounds, focus rings, stamp wash */

  /* Semantic only — never decorative */
  --alert:       #C8200F;   /* errors, destructive actions, STOP THE PRESS */
  --alert-tint:  #FBE6E3;

  color-scheme: light;
}
```

**No dark mode.** This is a deliberate product decision: the audience
(volunteer church administrators, small-nonprofit staff) prefers a stable
single theme over a switcher they may flip by accident. The whole system is
designed around *paper* — and paper has one mode. Starlight's theme
switcher is overridden to a no-op in the docs site; the admin app's
`<meta name="color-scheme">` is pinned to `light`.

### Usage rules

- **Indigo is precious.** It marks one thing per region: the active tab, the primary button, the unvisited link. Never use it for decoration, never use it for two competing affordances side by side.
- **Alert red is even more precious.** It appears only on destructive confirms, validation failures, and bounce/quarantine status. If you find yourself reaching for red because "this is important," stop — use a `█ STAMP █` instead (see §7).
- **Neutrals carry everything else.** Hierarchy is built from weight, size, rules, and whitespace — not from color.
- **Light only.** There is no dark mode. See the §4 note above — paper has one mode, and that's the brand.

## 5. Type system

Three voices, each with one job. Never use a voice outside its job.

| Voice            | Family                                                  | Weights      | Uses                                                                                  |
| ---------------- | ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| **Masthead Serif** | Source Serif 4 (fallback: Charter, Georgia, serif)     | 400, 600     | Wordmarks, page headlines (H1), hero taglines, pull quotes, dropcaps                  |
| **Industrial Sans**| Inter (fallback: -apple-system, system-ui, sans-serif) | 400, 500, 600| Body text, H2–H6, form labels, buttons, navigation                                    |
| **Plex Mono**    | IBM Plex Mono (fallback: ui-monospace, Menlo, monospace)| 400, 600     | Datelines, volume markers, IDs, email addresses, headers, code, table coordinates, metadata |

### Stacks

```css
--font-serif: "Source Serif 4", "Source Serif Pro", Charter, "Iowan Old Style", Georgia, serif;
--font-sans:  Inter, -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
--font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
```

Web fonts are loaded only for serif and mono (Inter is system-good-enough on macOS/iOS; Google Fonts subset for Linux/Android). Body sans falls through to `system-ui` to keep cold-page load fast — newsprint pages should appear instantly.

### Scale

8px base unit. Type scale is **modular at 1.250 (major third)** for the sans/mono ladder; the serif gets its own headline ladder at 1.414 (augmented fourth) so the masthead reads taller than the body would suggest.

```css
/* sans/mono — UI scale */
--text-xs:   12px;   /* dateline, table headers, captions */
--text-sm:   14px;   /* metadata, secondary nav */
--text-base: 16px;   /* body */
--text-md:   18px;   /* H4 / lead paragraph */
--text-lg:   22px;   /* H3 */

/* serif — headline scale */
--serif-h2:  28px;
--serif-h1:  44px;
--serif-hero: 64px;  /* masthead-only, marketing/docs landing */
```

Body line-height: `1.6` for sans, `1.5` for serif headlines (tight), `1.45` for mono.

### Small-caps and tracking

The dateline, section labels, and table headers all use the same treatment:

```css
.smallcaps {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-muted);
}
```

This is the connective tissue across the whole system — if a reader recognizes the dateline style on the docs page, they should recognize it as the section label on the admin page.

## 6. Spacing, grid, layout

### Spacing scale

Powers of 8, ascending. No `13px` margins, ever.

```
4   8   12   16   24   32   48   64   96   128
```

### Page widths

| Surface             | Max content width | Notes                                                                |
| ------------------- | ----------------- | -------------------------------------------------------------------- |
| Docs body (single)  | 680px             | Reading column — optimized for prose                                 |
| Docs landing (multi)| 1100px            | Two- to three-column broadsheet layout                               |
| Admin shell         | 1024px            | Tables breathe; never go edge-to-edge on desktop                     |
| Sign-in / single-task| 384px            | Centered, vertical                                                   |

### Column rules

Real broadsheet pages used 1px vertical rules between columns. We do the same — `1px solid var(--rule)` between content columns, never a gutter alone. The rule *is* the gutter.

```css
.broadsheet {
  display: grid;
  grid-template-columns: 1fr 1px 1fr;
  gap: 32px;
  align-items: start;
}
.broadsheet > .rule { background: var(--rule); align-self: stretch; }
```

(`display: grid` with explicit `1px` track is the cleanest way; a `border-right` works too but does not extend full-height when columns differ in length.)

## 7. Layout primitives

These are the named components every page is built from.

### 7.1 Masthead

See §3. CSS sketch:

```html
<header class="masthead">
  <h1 class="wordmark">THE BULLETIN</h1>
  <div class="masthead-rule"></div>
  <span class="masthead-volume">VOL. I · 2026</span>
</header>
<p class="dateline">MONDAY · MAY 25 · MAILING LISTS THAT JUST WORK</p>
```

```css
.masthead {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 24px 0 8px;
  border-bottom: 2px solid var(--rule-strong);
}
.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 32px;
  letter-spacing: -0.01em;
  margin: 0;
}
.masthead-rule { height: 2px; background: var(--indigo); }
.masthead-volume {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink-muted);
}
.dateline { /* uses .smallcaps */ padding: 8px 0 32px; margin: 0; }
```

### 7.2 Section rule

Used to break long-form content. Replaces traditional H2-on-blank-line.

```
─── SELF-HOSTING ─────────────────────────────────────
```

```css
.section-rule {
  display: grid;
  grid-template-columns: 32px auto 1fr;
  gap: 12px;
  align-items: center;
  margin: 48px 0 24px;
}
.section-rule::before, .section-rule::after { content: ""; height: 1px; background: var(--ink); }
.section-rule .label { /* uses .smallcaps */ color: var(--ink); }
```

### 7.3 Dropcap

On the first paragraph of a long doc page (tutorials, explanation, how-tos > 500 words), the first letter is set as a serif dropcap, three lines tall, with a 1px box around it.

```css
.dropcap::first-letter {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 56px;
  float: left;
  line-height: 0.9;
  padding: 6px 10px 0 0;
  margin: 4px 8px 0 0;
  border: 1px solid var(--ink);
}
```

The boxed dropcap is the broadsheet-meets-Braun signature — newspapers don't normally box their dropcaps, but Braun would.

### 7.4 Pull quote

```html
<blockquote class="pull-quote">
  <p>"Owning the parent domain is the whole architectural bet."</p>
  <cite>— PRD.md, §3</cite>
</blockquote>
```

```css
.pull-quote {
  border-left: 2px solid var(--indigo);
  padding: 0 0 0 24px;
  margin: 32px 0;
  font-family: var(--font-serif);
  font-size: 22px;
  font-style: italic;
  line-height: 1.4;
}
.pull-quote cite {
  display: block;
  margin-top: 12px;
  font: 12px var(--font-sans);
  font-style: normal;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
```

### 7.5 Stamp

The "stamp" is BulletinMail's status badge. Inspired by library-card date stamps. Used for things like `SENT`, `BOUNCED`, `QUEUED`, `MEMBER`, `NEW`.

```html
<span class="stamp">SENT</span>
<span class="stamp stamp--alert">BOUNCED</span>
```

```css
.stamp {
  display: inline-block;
  font: 600 11px var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 6px;
  border: 1px solid var(--indigo);
  color: var(--indigo);
  background: var(--indigo-tint);
  border-radius: 0;     /* never round a stamp */
}
.stamp--alert { border-color: var(--alert); color: var(--alert); background: var(--alert-tint); }
.stamp--quiet { border-color: var(--rule); color: var(--ink-muted); background: transparent; }
```

Stamps are square-cornered. They are the *only* component that gets to look like ink on paper.

### 7.6 Classifieds table

Tables, in BulletinMail, look like newspaper classifieds — small caps header, hairline column rules, mono for any technical field, alternating paper-2 rows optional but available.

```html
<table class="classifieds">
  <thead>
    <tr>
      <th>Name</th>
      <th>Members</th>
      <th>Last sent</th>
      <th class="num">Bounce rate</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>announcements</td>
      <td><span class="mono">142</span></td>
      <td>2 days ago</td>
      <td class="num"><span class="mono">0.7%</span></td>
    </tr>
  </tbody>
</table>
```

```css
.classifieds { width: 100%; border-collapse: collapse; }
.classifieds th {
  /* uses .smallcaps */
  text-align: left;
  border-bottom: 1px solid var(--ink);
  padding: 8px 12px;
}
.classifieds td {
  padding: 12px;
  border-bottom: 1px solid var(--rule);
  vertical-align: baseline;
}
.classifieds .num { text-align: right; font-variant-numeric: tabular-nums; }
.classifieds .mono { font-family: var(--font-mono); font-size: 13px; }
```

### 7.7 Footer colophon

Every page ends with a printer's colophon, mono, ink-muted.

```
─────────────────────────────────────────────────────────────
SET IN SOURCE SERIF, INTER, IBM PLEX MONO · AGPL-3.0
TYPE LEAD POURED ON CLOUDFLARE WORKERS · NO COOKIES · NO ADS
```

## 8. Components (admin & marketing)

### Buttons

Square-cornered or 2px corners only. No shadow. No gradient.

```css
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  font: 500 14px var(--font-sans);
  padding: 8px 16px;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  border-radius: 2px;
  cursor: pointer;
}
.btn:hover { background: var(--paper-2); }
.btn--primary {
  background: var(--indigo);
  border-color: var(--indigo);
  color: var(--indigo-ink);
}
.btn--primary:hover { filter: brightness(1.1); }
.btn--alert { border-color: var(--alert); color: var(--alert); }
.btn--alert:hover { background: var(--alert-tint); }
.btn--ghost { border-color: transparent; }
```

### Inputs

```css
.field {
  font: 14px var(--font-sans);
  padding: 8px 12px;
  border: 1px solid var(--rule);
  background: var(--paper);
  color: var(--ink);
  border-radius: 2px;
  min-height: 36px;
}
.field:focus {
  outline: 0;
  border-color: var(--indigo);
  box-shadow: inset 0 0 0 1px var(--indigo);
}
textarea.field { font-family: var(--font-mono); font-size: 13px; min-height: 160px; }
```

Email addresses in inputs render in mono — they are identifiers, not prose.

### Links

```css
a {
  color: var(--indigo);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}
a:hover { background: var(--indigo-tint); }
a:visited { color: var(--indigo); }   /* deliberate — no purple Craigslist drift */
```

Underlined links. Always. This is the one piece of Craigslist we keep verbatim — clickable text declares itself.

### Banners

```css
.banner {
  border: 1px solid var(--rule);
  border-left-width: 3px;
  padding: 12px 16px;
  font: 14px var(--font-sans);
  background: var(--paper-2);
}
.banner--ok    { border-left-color: var(--indigo); }
.banner--alert { border-left-color: var(--alert); background: var(--alert-tint); }
```

## 9. Motion

Almost none. Specifically:
- No page-transition animations.
- No skeleton loaders — show "Loading…" in mono, ink-muted, on a paper background. The mono font *is* the loading skeleton.
- Hover transitions: `150ms ease-out` on color/background only.
- Focus rings appear instantly.

This is intentional. The design is meant to feel like ink on paper. Paper does not animate.

## 10. Accessibility

- All accent colors are tested for ≥4.5:1 contrast against their backgrounds (light and dark modes both).
- Focus rings are visible and indigo — not removed for aesthetics. The 1px inset shadow approach above keeps the visual weight low without sacrificing visibility.
- The `prefers-reduced-motion` query removes the 150ms transitions entirely.
- Touch targets minimum 36px (one row of the 8px grid × 4 + 4 padding above + below); buttons size up to 44px on mobile.
- Underlined links are non-negotiable; do not strip underlines in any "decorative" context. Color-alone is not enough for color-blind users.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 11. Anti-patterns

If you catch yourself doing one of these, stop and re-read this document.

| Anti-pattern                                  | Why it breaks the system                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Adding a third color "for variety"            | We have one accent. Variety comes from typography, not chroma.                        |
| Stripping link underlines                     | Craigslist principle — text must declare clickability.                                 |
| Rounded "pill" buttons or badges              | We are ink on paper. Ink does not have rounded corners.                                |
| Drop shadows on cards                         | Paper does not float. Use a 1px rule instead.                                          |
| Emoji as iconography                          | They render inconsistently and clash with the type voice. Use mono symbols (`→ · §`).  |
| Sans-serif headlines                          | Headlines are serif. Always. That is the load-bearing identity decision.               |
| Multi-line, multi-paragraph admin button labels| Buttons are labels, not sentences. If you need a sentence, write a banner.            |
| Gradient backgrounds                          | One-color flat fields only. Indigo on paper or paper on indigo — never indigo→purple.  |
| Hiding the dateline / volume marker           | These are the load-bearing identity elements. Every page keeps them.                   |
| Mono for body prose                           | Mono is for identifiers. Body is sans. Headlines are serif. Stay in lane.              |

## 12. Surface map — where this lands

| Surface                       | Implementation                                                                  | Specific patterns                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **`apps/docs/`** landing (`/`)| Astro/Starlight `template: splash` override + custom CSS                        | Full broadsheet — masthead, dateline, 2-col hero, classifieds CTAs      |
| **`apps/docs/`** content pages| Starlight default w/ injected `customCss` for tokens, fonts, dropcap, section rules | Single-column 680px body. Dropcap on first paragraph. Section rules between H2s |
| **`apps/admin/`** shell       | `src/styles.css` rewrite using these tokens                                     | Masthead (admin variant), breadcrumb dateline, classifieds-style tables |
| **`apps/admin/`** sign-in     | `src/views/signin.ts`                                                           | 384px center column, large serif `BULLETINMAIL`, mono `v1.0` next to it |
| **Marketing pages** (future)  | Static HTML in repo, same `tokens.css`                                          | Full broadsheet                                                          |
| **Sent-mail HTML body**       | RFC-safe inline-only CSS subset                                                  | Masthead in serif, dateline mono, **no web fonts** (system serifs only) |

### Shared CSS

A single file lives at `packages/shared/design/tokens.css` and is imported by both:
- `apps/admin/src/styles.css` (`@import "../../../packages/shared/design/tokens.css"`)
- `apps/docs/src/styles/global.css` (registered via Starlight `customCss`)

Component CSS (`.btn`, `.stamp`, `.classifieds`, etc.) lives in `packages/shared/design/components.css` and is imported the same way. The admin app uses these classes directly; the docs site can override Starlight component slots that map to them.

### Font loading

`packages/shared/design/fonts.css` loads:
- Source Serif 4 (400, 600) — woff2, self-hosted at `/fonts/` on each app
- IBM Plex Mono (400, 600) — woff2, self-hosted
- Inter — `font-display: optional` so system-ui shows first; Inter swaps in if cached

This file is also imported by both apps. Self-hosting fonts is non-negotiable: a privacy-first product cannot ship Google Fonts on a no-cookie page.

## 13. The test

You're not done with a screen until you can answer yes to all of these:

1. Could this print legibly on newsprint?
2. If you stripped the indigo, would the hierarchy still hold?
3. Does the dateline / masthead identify the page without a logo?
4. Are addresses, IDs, and numbers in mono? Is prose in sans? Are headlines in serif?
5. Is there exactly one primary action, and is it the only indigo button?
6. Could a volunteer church administrator, on a 2014 Chromebook, on hotel WiFi, read this comfortably?

If yes to all six: ship it.

---

*Set in Source Serif 4, Inter, and IBM Plex Mono. Designed for archival legibility, built for the small organizations who shouldn't need a designer.*
