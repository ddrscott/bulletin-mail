#!/usr/bin/env node
/**
 * Build script for the admin SPA → dist/admin/.
 *
 * Emits the SPA under /admin/ so Workers Assets serves it at <host>/admin/
 * on both the apex (post-collapse) and <tenant>.<apex>. Bundles admin/main.ts
 * via esbuild, bundles admin/styles.css (resolves the
 * @bulletinmail/shared/design/* imports via esbuild's CSS bundler), and copies
 * index.html. Astro build creates dist/ first; this script writes into dist/admin/.
 */

import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";

const root = new URL(".", import.meta.url).pathname;
const dist = `${root}dist`;
const distAdmin = `${dist}/admin`;

// Clean only the admin subdirectory — Astro's output (dist/docs) lives at a
// peer path and must survive.
await rm(distAdmin, { recursive: true, force: true });
await mkdir(distAdmin, { recursive: true });

// Favicon needs to live at dist/favicon.svg so it's served at <apex>/favicon.svg
// (browsers' default fetch path). Astro puts a copy at dist/docs/favicon.svg
// for docs pages; we copy the source to the dist root for landing/admin/contact.
await copyFile(`${root}public/favicon.svg`, `${dist}/favicon.svg`);

await build({
  entryPoints: [`${root}admin/main.ts`],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: `${distAdmin}/main.js`,
  minify: true,
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: [`${root}admin/styles.css`],
  bundle: true,
  outfile: `${distAdmin}/styles.css`,
  loader: { ".woff2": "file" },
  minify: true,
  logLevel: "info",
});

const html = await readFile(`${root}admin/index.html`, "utf8");
await writeFile(`${distAdmin}/index.html`, html);

console.log(`built → ${distAdmin}`);
