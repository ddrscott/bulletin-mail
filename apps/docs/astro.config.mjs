// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// The docs site is served at the reference instance's apex
// (bulletinmail.org). Forks should change `site` to their own apex.
export default defineConfig({
  site: "https://bulletinmail.org",
  integrations: [
    starlight({
      title: "BulletinMail",
      description: "Mailing lists that just work — multi-tenant, open source, runs on Cloudflare.",
      customCss: ["./src/styles/global.css"],
      components: {
        Header: "./src/components/Header.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      social: {
        github: "https://github.com/ddrscott/bulletin-mail",
      },
      editLink: {
        baseUrl: "https://github.com/ddrscott/bulletin-mail/edit/main/apps/docs/",
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
