import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Docs live at the repo root in /docs/ — that's the canonical source. Astro's
// content collection points at it via the glob loader's `base` option,
// eliminating the previous duplicated tree at src/content/docs/. Editors and
// GitHub readers see /docs/ as the home; Starlight reads through this binding.
//
// `base` is relative to the project root (where astro.config.mjs lives).
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "./docs" }),
    schema: docsSchema(),
  }),
};
