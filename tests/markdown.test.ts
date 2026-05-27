import { describe, expect, it } from "vitest";
import { compileMarkdown } from "../server/wiki/markdown.js";

describe("compileMarkdown — wiki links", () => {
  it("renders [[Page Name]] as a kebab-case wiki link", () => {
    const html = compileMarkdown("See [[Getting Started]] for details.");
    expect(html).toContain('href="/wiki/getting-started"');
    expect(html).toContain("Getting Started</a>");
  });

  it("renders [[Page|Label]] with custom label", () => {
    const html = compileMarkdown("See [[Getting Started|the intro]].");
    expect(html).toContain('href="/wiki/getting-started"');
    expect(html).toContain(">the intro</a>");
  });

  it("normalizes escaped \\[\\[Page\\]\\] from ProseMirror serializers", () => {
    // Milkdown Crepe emits backslash-escaped brackets to keep them out of
    // markdown link syntax. The compile step should still detect wiki links.
    const html = compileMarkdown("See \\[\\[Getting Started\\]\\] for details.");
    expect(html).toContain('href="/wiki/getting-started"');
    expect(html).toContain("Getting Started</a>");
  });

  it("normalizes escaped \\[\\[Page|Label\\]\\] with custom label", () => {
    const html = compileMarkdown("See \\[\\[Getting Started|the intro\\]\\].");
    expect(html).toContain('href="/wiki/getting-started"');
    expect(html).toContain(">the intro</a>");
  });

  it("handles asymmetric escape \\[\\[Page]] (open escaped, close bare)", () => {
    // Milkdown Crepe emits this exact form: opening brackets escaped,
    // closing brackets bare. Live debugging confirmed via /api/wiki/:slug/versions.
    const html = compileMarkdown("Link out: \\[\\[About]], \\[\\[Contact]].");
    expect(html).toContain('href="/wiki/about"');
    expect(html).toContain('href="/wiki/contact"');
  });
});

describe("compileMarkdown — image safety", () => {
  it("drops javascript: image src", () => {
    const html = compileMarkdown("![bad](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });

  it("keeps http(s) image src", () => {
    const html = compileMarkdown("![ok](https://example.org/x.png)");
    expect(html).toContain('src="https://example.org/x.png"');
  });
});

describe("compileMarkdown — embeds", () => {
  it("embeds a YouTube watch URL", () => {
    const html = compileMarkdown("{{embed https://www.youtube.com/watch?v=dQw4w9WgXcQ}}");
    expect(html).toContain('class="wiki-embed"');
    expect(html).toContain('data-provider="youtube"');
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("allowfullscreen");
  });

  it("embeds a youtu.be short URL", () => {
    const html = compileMarkdown("{{embed https://youtu.be/dQw4w9WgXcQ}}");
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
  });

  it("embeds a YouTube Shorts URL", () => {
    const html = compileMarkdown("{{embed https://www.youtube.com/shorts/abc123XYZ}}");
    expect(html).toContain('src="https://www.youtube.com/embed/abc123XYZ"');
  });

  it("preserves a YouTube start-time parameter", () => {
    const html = compileMarkdown("{{embed https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42}}");
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=42"');
  });

  it("embeds a Vimeo URL", () => {
    const html = compileMarkdown("{{embed https://vimeo.com/123456789}}");
    expect(html).toContain('data-provider="vimeo"');
    expect(html).toContain('src="https://player.vimeo.com/video/123456789"');
  });

  it("embeds a Loom URL", () => {
    const html = compileMarkdown("{{embed https://www.loom.com/share/abc123def456}}");
    expect(html).toContain('data-provider="loom"');
    expect(html).toContain('src="https://www.loom.com/embed/abc123def456"');
  });

  it("embeds a CodePen URL", () => {
    const html = compileMarkdown("{{embed https://codepen.io/chriscoyier/pen/XWJYzaG}}");
    expect(html).toContain('data-provider="codepen"');
    expect(html).toContain("https://codepen.io/chriscoyier/embed/XWJYzaG");
  });

  it("falls back to a plain link for unknown providers", () => {
    const html = compileMarkdown("{{embed https://example.org/whatever}}");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('href="https://example.org/whatever"');
  });

  it("rejects javascript: URLs (no iframe, no link)", () => {
    const html = compileMarkdown("{{embed javascript:alert(1)}}");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("javascript:");
  });

  it("does not embed when the token is mid-paragraph", () => {
    const html = compileMarkdown("text {{embed https://youtu.be/abc}} text");
    expect(html).not.toContain("<iframe");
  });

  it("escapes HTML in YouTube IDs to defeat attribute breakout", () => {
    const html = compileMarkdown('{{embed https://youtu.be/abc"><script>x</script>}}');
    expect(html).not.toContain("<script>");
  });

  it("emits the embed at block level (not wrapped in <p>)", () => {
    const html = compileMarkdown("{{embed https://youtu.be/dQw4w9WgXcQ}}");
    expect(html).not.toMatch(/<p>\s*<div class="wiki-embed"/);
  });
});
