// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Docs are served under /docs/ at the apex (bulletinmail.org). The bare apex
// '/' is a server-rendered landing page in the Worker (src/worker/routes/landing.ts).
//
// `outDir: './dist/docs'` + `base: '/docs/'` together produce a tree where
// the file layout matches the URL layout — Astro's `base` only rewrites URLs
// inside HTML, it doesn't nest the dist tree. The web Worker's [assets]
// binding points at `./dist`, so dist/docs/* serves at <apex>/docs/* and
// dist/admin/* (written by build-admin.mjs) serves at <apex>/admin/*.
//
// Forks should change `site` to their own apex.
export default defineConfig({
  site: "https://bulletinmail.org",
  base: "/docs/",
  outDir: "./dist/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "BulletinMail",
      description: "Mailing lists that just work — multi-tenant, open source, runs on Cloudflare.",
      customCss: ["./src/styles/global.css"],
      components: {
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      social: {
        github: "https://github.com/ddrscott/bulletin-mail",
      },
      editLink: {
        baseUrl: "https://github.com/ddrscott/bulletin-mail/edit/main/apps/web/",
      },
      sidebar: [
        {
          label: "Tutorial",
          autogenerate: { directory: "tutorial" },
        },
        {
          label: "How-to",
          autogenerate: { directory: "how-to" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Explanation",
          autogenerate: { directory: "explanation" },
        },
      ],
    }),
  ],
});
