#!/usr/bin/env node
/**
 * Build script for apps/admin → apps/admin/dist/admin/.
 *
 * Emits the SPA under /admin/ so Workers Assets serves it at <host>/admin/
 * on both app.<apex> and <tenant>.<apex> without trailing-slash redirects
 * fighting us. App.<apex>/ redirects to /admin/ in the Worker.
 *
 * Bundles src/main.ts via esbuild, bundles src/styles.css (resolves the
 * @bulletinmail/shared/design/* imports via esbuild's CSS bundler), copies
 * index.html. The resulting dist/admin/ is what workers/web's [assets]
 * binding serves.
 */

import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

const root = new URL(".", import.meta.url).pathname;
const dist = `${root}dist`;
const distAdmin = `${dist}/admin`;

await rm(dist, { recursive: true, force: true });
await mkdir(distAdmin, { recursive: true });

await build({
  entryPoints: [`${root}src/main.ts`],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: `${distAdmin}/main.js`,
  minify: true,
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: [`${root}src/styles.css`],
  bundle: true,
  outfile: `${distAdmin}/styles.css`,
  loader: { ".woff2": "file" },
  minify: true,
  logLevel: "info",
});

const html = await readFile(`${root}src/index.html`, "utf8");
await writeFile(`${distAdmin}/index.html`, html);

console.log(`built → ${distAdmin}`);
