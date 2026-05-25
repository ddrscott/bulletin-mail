#!/usr/bin/env node
/**
 * One-shot migration: read /docs/*.md (repo-root canonical source) and emit
 * Starlight-compatible copies into apps/docs/src/content/docs/. Adds
 * frontmatter, strips the leading H1 (Starlight renders the title from
 * frontmatter), and rewrites internal links to clean URLs.
 *
 * Idempotent — re-running overwrites with a fresh copy from /docs/.
 *
 * Link rewriting is source-path-aware: a link's target is resolved relative
 * to the *source* file's directory, then classified:
 *   - Inside the docs/ tree and known (matches a FILES.src entry):
 *       /{section}/{slug}/ — Starlight clean URL.
 *   - Outside the docs/ tree (e.g. ../../PRD.md, ../packages/...):
 *       https://github.com/<repo>/blob/main/<path> — GitHub source link.
 *   - Anything else (relative-but-unknown): leave unchanged + warn.
 *
 * If link text was the bare `foo.md` filename, the `.md` suffix is stripped
 * from the rendered text too (humans don't need to see file extensions).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../../..", import.meta.url).pathname);
const srcDir = path.join(root, "docs");
const dstDir = path.join(root, "apps/docs/src/content/docs");

const REPO = "ddrscott/bulletin-mail";
const DOCS_TOP_LEVELS = new Set(["tutorial", "how-to", "reference", "explanation"]);

/** @type {Array<{src: string, dst: string, title: string, desc: string}>} */
const FILES = [
  { src: "how-to/self-host.md", dst: "how-to/self-host.md",
    title: "Self-host your own instance",
    desc: "Deploy BulletinMail to your own Cloudflare account in ~90 minutes." },
  { src: "how-to/operations.md", dst: "how-to/operations.md",
    title: "Day-2 operations",
    desc: "Routine ops, incident triage, capacity, decommissioning a tenant." },
  { src: "reference/cli.md", dst: "reference/cli.md",
    title: "CLI reference",
    desc: "bulletin operator commands for tenants, groups, and members." },
  { src: "reference/instance-config.md", dst: "reference/instance-config.md",
    title: "InstanceConfig schema",
    desc: "Per-deployment configuration: every field, type, and default." },
  { src: "explanation/architecture.md", dst: "explanation/architecture.md",
    title: "Architecture overview",
    desc: "The pipeline in one paragraph + hot paths for new contributors." },
  { src: "explanation/distribution-model.md", dst: "explanation/distribution-model.md",
    title: "Distribution model",
    desc: "AGPL-3.0 choice, three-layer separation, what lives where." },
  { src: "explanation/domain-strategy.md", dst: "explanation/domain-strategy.md",
    title: "Domain strategy",
    desc: "Why each tenant gets its own DNS subdomain — and the Cloudflare workaround forced on the From header." },
  { src: "explanation/http-routing.md", dst: "explanation/http-routing.md",
    title: "HTTP routing",
    desc: "One Worker handles every request to the apex + every subdomain (the relaytty.com playbook)." },
];

const VALID_DOCS = new Set(FILES.map((f) => f.src));
const SITE_URL_BY_SRC = new Map(
  FILES.map((f) => {
    const dirPart = path.posix.dirname(f.dst);
    const slug = path.posix.basename(f.dst, ".md");
    return [f.src, `/${dirPart}/${slug}/`];
  }),
);

const yamlEsc = (s) => s.replace(/"/g, '\\"');

function stripDotMdText(text) {
  return text.endsWith(".md") ? text.slice(0, -3) : text;
}

function rewriteLinks(srcRel, body) {
  const srcDirRel = path.posix.dirname(srcRel);
  let warnings = 0;

  const out = body.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
    // External: leave alone.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return match;
    // Pure anchor: leave alone.
    if (href.startsWith("#")) return match;
    // Already absolute path under the site: leave alone.
    if (href.startsWith("/")) return match;

    // Split off anchor/query.
    const m = href.match(/^([^#?]+)(.*)$/);
    if (!m) return match;
    const pathPart = m[1];
    const suffix = m[2] ?? "";

    // Resolve against the source file's directory. The result is repo-rel
    // FROM the docs/ root (e.g. "explanation/domain-strategy.md", "PRD.md").
    const resolved = path.posix.normalize(path.posix.join(srcDirRel, pathPart));
    const firstSeg = resolved.split("/")[0] ?? "";

    // Outside the docs/ tree → GitHub source link.
    if (!DOCS_TOP_LEVELS.has(firstSeg)) {
      const repoPath = resolved.replace(/^(\.\.\/)+/, "");
      const ghUrl = `https://github.com/${REPO}/blob/main/${repoPath}${suffix}`;
      return `[${stripDotMdText(text)}](${ghUrl})`;
    }

    // Inside docs/ and known → clean URL.
    if (VALID_DOCS.has(resolved)) {
      const siteUrl = SITE_URL_BY_SRC.get(resolved) + suffix;
      return `[${stripDotMdText(text)}](${siteUrl})`;
    }

    // Inside docs/ but unknown — typo, deleted, or a not-yet-migrated file.
    // Leave the link untouched; warn so we notice during the build.
    warnings++;
    console.warn(`  ! ${srcRel}: unknown in-docs link → ${pathPart} (resolves to ${resolved})`);
    return match;
  });

  return { body: out, warnings };
}

function stripLeadingH1(body) {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^# /.test(lines[i])) {
    let j = i + 1;
    if (j < lines.length && lines[j].trim() === "") j++;
    return lines.slice(j).join("\n");
  }
  return body;
}

let totalWarnings = 0;
for (const f of FILES) {
  const srcPath = path.join(srcDir, f.src);
  const dstPath = path.join(dstDir, f.dst);
  const raw = await readFile(srcPath, "utf8");
  const { body: rewritten, warnings } = rewriteLinks(f.src, stripLeadingH1(raw));
  totalWarnings += warnings;
  const out = `---
title: "${yamlEsc(f.title)}"
description: "${yamlEsc(f.desc)}"
---

${rewritten.trimStart()}`;
  await mkdir(path.dirname(dstPath), { recursive: true });
  await writeFile(dstPath, out);
  console.log(`migrated ${f.src} → ${f.dst}`);
}

console.log(`\nMigrated ${FILES.length} files. Warnings: ${totalWarnings}.`);
