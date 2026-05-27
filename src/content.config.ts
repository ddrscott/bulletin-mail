import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Starlight's docsLoader reads from src/content/docs/ — a symlink there points
// at /docs/ at the repo root. The canonical content lives at the root so it's
// GitHub-readable and easy to find; the symlink lets Starlight's loader +
// sidebar autogenerate work unmodified (a custom glob loader's ID format
// doesn't match Starlight's autogenerate filter).
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
