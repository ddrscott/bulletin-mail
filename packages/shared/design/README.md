# @bulletinmail/shared/design

Shared CSS source-of-truth for **`apps/admin`** and **`apps/docs`**. Spec: [`/DESIGN.md`](../../../DESIGN.md).

## Files

| File              | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `tokens.css`      | All design tokens — colors, type voices, spacing scale, widths. Light + dark. |
| `fonts.css`       | `@font-face` declarations for Source Serif 4, Inter, IBM Plex Mono.            |
| `components.css`  | Element resets + every shared component (masthead, stamps, classifieds, etc.). |

## Load order

```css
@import "@bulletinmail/shared/design/tokens.css";
@import "@bulletinmail/shared/design/fonts.css";
@import "@bulletinmail/shared/design/components.css";
```

Tokens must come first — `fonts.css` and `components.css` both depend on them.

## How each app consumes it

### `apps/admin`

`apps/admin/src/styles.css` is the entry point and `@import`s these three files. The build script (`build.mjs`) copies the resolved CSS into `dist/styles.css`, so the deployed admin page ships a single flat stylesheet — no runtime resolution.

### `apps/docs`

Registered in `apps/docs/astro.config.mjs` via Starlight's `customCss`. Astro resolves the imports at build time and bundles them.

## Why CDN-hosted fonts (for now)

`fonts.css` references [Bunny Fonts](https://fonts.bunny.net) — a GDPR-compliant, cookieless mirror of Google Fonts. The `/DESIGN.md` spec calls for full self-hosting; the migration path is:

1. Run a one-time script to download the woff2 files into `./fonts/`.
2. Rewrite `@font-face src:` URLs to relative paths (`url("fonts/source-serif-4-400.woff2")`).
3. Ensure each consuming app's build step copies `./fonts/` alongside the CSS.

Bunny Fonts is the privacy-acceptable interim — no cookies, no tracking, no Google.

## Class index

See `components.css` header for the full list. Highlights:

- **Layout:** `.masthead`, `.wordmark`, `.masthead-rule`, `.masthead-volume`, `.dateline`, `.broadsheet`, `.section-rule`, `.colophon`
- **Type:** `.dropcap`, `.smallcaps`, `.mono`, `.pull-quote`
- **Data:** `.classifieds` (table), `.stamp` / `.stamp--alert` / `.stamp--quiet`
- **Controls:** `.btn` / `.btn--primary` / `.btn--alert` / `.btn--ghost` / `.btn--small`, `.field`
- **Feedback:** `.banner` / `.banner--ok` / `.banner--alert`

## Don't

- Don't add a third accent color. Indigo is precious; alert red is semantic-only.
- Don't add `border-radius` larger than `--radius-control` (2px). Stamps are square.
- Don't add `box-shadow`. Paper does not float.
- Don't add CSS to individual app stylesheets that could live here. Any pattern needed by both apps belongs in `components.css`.
