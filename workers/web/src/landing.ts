/**
 * Apex landing page. Minimal placeholder — the maintainer of any given
 * instance should replace this with their own copy via their
 * deployments/<apex>/ overlay (Phase 2 will move this into the overlay so
 * the OSS code doesn't ship marketing for any specific operator).
 */

import type { InstanceConfig } from "@bulletinmail/shared";

export function renderLanding(config: InstanceConfig): string {
  // Escape any characters that could break out of HTML context.
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(config.productName)}</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    p { color: #555; }
    a { color: #06c; }
  </style>
</head>
<body>
  <h1>${esc(config.productName)}</h1>
  <p>${esc(config.tagline)}</p>
  <p><a href="${esc(config.adminUrl)}">Admin</a></p>
</body>
</html>`;
}
