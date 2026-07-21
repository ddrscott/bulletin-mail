import { describe, expect, it, vi } from "vitest";
import { loadFromEnv, defaults } from "@bulletinmail/shared";
import { aiUsageDay } from "@bulletinmail/db";
import {
  aiLimitMessage,
  buildAutogenPrompt,
  buildHeroImagePrompt,
  buildPromotePrompt,
  enabledAiFeatures,
  GEN_INPUT_MAX_CHARS,
  generateImageBytes,
  generateMarkdown,
  promoteSourceFooter,
} from "../server/lib/ai.js";
import type { AiBindingLike } from "../server/wiki/summary.js";

const BASE_ENV: Record<string, unknown> = {
  INSTANCE_APEX_DOMAIN: "example.org",
  INSTANCE_PRODUCT_NAME: "Example Lists",
  INSTANCE_PRODUCT_NAME_SHORT: "Lists",
  INSTANCE_TAGLINE: "...",
  INSTANCE_ARCHIVE_URL: "https://example.org/g/{tenant}/{group}",
  INSTANCE_UNSUB_URL: "https://example.org/u/{token}",
  INSTANCE_OPERATOR_LEGAL_NAME: "Example Org",
  INSTANCE_OPERATOR_MAILING_ADDRESS: "...",
  INSTANCE_OPERATOR_CONTACT_URL: "https://example.org/contact",
};

describe("config: features.ai + ai knobs", () => {
  it("defaults every AI feature to OFF and applies default models/cap", () => {
    const config = loadFromEnv(BASE_ENV);
    expect(config.features.ai).toEqual({
      promoteToWiki: false,
      wikiAutogen: false,
      wikiHeroImages: false,
    });
    expect(config.ai.dailyGenerationCap).toBe(defaults.ai.dailyGenerationCap);
    expect(config.ai.textModel).toBe(defaults.ai.textModel);
    expect(config.ai.imageModel).toBe(defaults.ai.imageModel);
  });

  it("parses each flag independently from env vars", () => {
    const config = loadFromEnv({
      ...BASE_ENV,
      INSTANCE_FEATURE_AI_PROMOTE_TO_WIKI: "true",
      INSTANCE_FEATURE_AI_WIKI_HERO_IMAGES: "1",
    });
    expect(config.features.ai.promoteToWiki).toBe(true);
    expect(config.features.ai.wikiAutogen).toBe(false);
    expect(config.features.ai.wikiHeroImages).toBe(true);
  });

  it("reads cap and model ids from env (operator-configurable, not hard-coded)", () => {
    const config = loadFromEnv({
      ...BASE_ENV,
      INSTANCE_AI_DAILY_CAP: "5",
      INSTANCE_AI_TEXT_MODEL: "@cf/vendor/next-model",
      INSTANCE_AI_IMAGE_MODEL: "@cf/vendor/next-image",
    });
    expect(config.ai.dailyGenerationCap).toBe(5);
    expect(config.ai.textModel).toBe("@cf/vendor/next-model");
    expect(config.ai.imageModel).toBe("@cf/vendor/next-image");
  });
});

describe("enabledAiFeatures", () => {
  const flagsOn = {
    features: {
      ai: { promoteToWiki: true, wikiAutogen: true, wikiHeroImages: true },
    },
  } as Parameters<typeof enabledAiFeatures>[0];

  it("is all-false when the Workers AI binding is absent, even with flags on", () => {
    expect(enabledAiFeatures(flagsOn, undefined)).toEqual({
      promoteToWiki: false,
      wikiAutogen: false,
      wikiHeroImages: false,
    });
  });

  it("is all-false when flags are off, even with the binding present", () => {
    const flagsOff = {
      features: { ai: { promoteToWiki: false, wikiAutogen: false, wikiHeroImages: false } },
    } as Parameters<typeof enabledAiFeatures>[0];
    expect(enabledAiFeatures(flagsOff, {})).toEqual({
      promoteToWiki: false,
      wikiAutogen: false,
      wikiHeroImages: false,
    });
  });

  it("requires flag AND binding, per feature", () => {
    const mixed = {
      features: { ai: { promoteToWiki: true, wikiAutogen: false, wikiHeroImages: true } },
    } as Parameters<typeof enabledAiFeatures>[0];
    expect(enabledAiFeatures(mixed, {})).toEqual({
      promoteToWiki: true,
      wikiAutogen: false,
      wikiHeroImages: true,
    });
  });
});

describe("aiUsageDay", () => {
  it("formats a UTC YYYY-MM-DD key", () => {
    expect(aiUsageDay(Date.UTC(2026, 6, 21, 23, 59, 0))).toBe("2026-07-21");
    // Just past midnight UTC → next day, regardless of local timezone.
    expect(aiUsageDay(Date.UTC(2026, 6, 22, 0, 1, 0))).toBe("2026-07-22");
  });
});

describe("aiLimitMessage", () => {
  it("names the cap and the config knob", () => {
    const msg = aiLimitMessage(7);
    expect(msg).toContain("7");
    expect(msg).toContain("dailyGenerationCap");
  });
});

describe("buildPromotePrompt", () => {
  it("includes the subject and each message with sender + date", () => {
    const prompt = buildPromotePrompt("Potluck logistics", [
      { fromLabel: "Pat", receivedAt: Date.UTC(2026, 0, 5), body: "Who brings plates?" },
      { fromLabel: "Sam", receivedAt: Date.UTC(2026, 0, 6), body: "I will." },
    ]);
    expect(prompt).toContain("Thread subject: Potluck logistics");
    expect(prompt).toContain("Message 1 (Pat, 2026-01-05)");
    expect(prompt).toContain("Who brings plates?");
    expect(prompt).toContain("Message 2 (Sam, 2026-01-06)");
  });

  it("truncates monster threads and says how many messages were omitted", () => {
    const big = "x".repeat(GEN_INPUT_MAX_CHARS);
    const prompt = buildPromotePrompt("s", [
      { fromLabel: "A", receivedAt: 0, body: big },
      { fromLabel: "B", receivedAt: 0, body: "late reply" },
      { fromLabel: "C", receivedAt: 0, body: "later reply" },
    ]);
    expect(prompt).toContain("omitted for length");
    expect(prompt).not.toContain("late reply");
  });
});

describe("promoteSourceFooter", () => {
  it("links the exact thread permalink", () => {
    const footer = promoteSourceFooter("abc123", "Potluck logistics");
    expect(footer).toContain("](/t/abc123)");
    expect(footer).toContain("Potluck logistics");
  });

  it("strips square brackets from the subject so the markdown link stays valid", () => {
    const footer = promoteSourceFooter("abc123", "[announce] thing");
    expect(footer).toContain("[announce thing](/t/abc123)");
  });

  it("falls back for empty subjects", () => {
    expect(promoteSourceFooter("abc", "  ")).toContain("(no subject)");
  });
});

describe("buildAutogenPrompt", () => {
  it("includes org, title, and existing pages as [[link]] fodder", () => {
    const prompt = buildAutogenPrompt("Demo Org", "Potluck Checklist", ["Index", "About"]);
    expect(prompt).toContain("Organization: Demo Org");
    expect(prompt).toContain("Missing page title: Potluck Checklist");
    expect(prompt).toContain("- Index");
    expect(prompt).toContain("- About");
  });

  it("handles an empty wiki", () => {
    expect(buildAutogenPrompt("Demo Org", "First Page", [])).toContain("(none yet)");
  });

  it("caps the existing-pages list at 50", () => {
    const titles = Array.from({ length: 80 }, (_, i) => `Page ${i}`);
    const prompt = buildAutogenPrompt("Demo Org", "T", titles);
    expect(prompt).toContain("- Page 49");
    expect(prompt).not.toContain("- Page 50\n");
  });
});

describe("generateMarkdown", () => {
  const fakeAi = (result: unknown): AiBindingLike => ({
    run: vi.fn(async () => result),
  });

  it("returns trimmed markdown from a { response } shape", async () => {
    const md = await generateMarkdown(fakeAi({ response: "  # Title\n\nBody  " }), "m", "s", "u");
    expect(md).toBe("# Title\n\nBody");
  });

  it("unwraps a whole-document code fence", async () => {
    const md = await generateMarkdown(
      fakeAi({ response: "```markdown\n# Title\n\nBody\n```" }),
      "m", "s", "u",
    );
    expect(md).toBe("# Title\n\nBody");
  });

  it("returns null for non-string / empty / throwing responses", async () => {
    expect(await generateMarkdown(fakeAi({ response: 42 }), "m", "s", "u")).toBeNull();
    expect(await generateMarkdown(fakeAi({ response: "   " }), "m", "s", "u")).toBeNull();
    const throwing: AiBindingLike = { run: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await generateMarkdown(throwing, "m", "s", "u")).toBeNull();
  });

  it("passes the configured model id through to the binding", async () => {
    const ai = fakeAi({ response: "ok" });
    await generateMarkdown(ai, "@cf/custom/model", "s", "u");
    expect(ai.run).toHaveBeenCalledWith("@cf/custom/model", expect.anything());
  });
});

describe("generateImageBytes", () => {
  it("decodes the flux-style { image: base64 } shape", async () => {
    const b64 = btoa("PNGBYTES");
    const ai: AiBindingLike = { run: vi.fn(async () => ({ image: b64 })) };
    const bytes = await generateImageBytes(ai, "m", "p");
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("PNGBYTES");
  });

  it("passes through raw binary shapes", async () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ai: AiBindingLike = { run: vi.fn(async () => raw) };
    expect(await generateImageBytes(ai, "m", "p")).toEqual(raw);
  });

  it("returns null on failure or unknown shapes", async () => {
    const weird: AiBindingLike = { run: vi.fn(async () => ({ nope: true })) };
    expect(await generateImageBytes(weird, "m", "p")).toBeNull();
    const throwing: AiBindingLike = { run: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await generateImageBytes(throwing, "m", "p")).toBeNull();
  });
});

describe("buildHeroImagePrompt", () => {
  it("mentions the page title and forbids text in the image", () => {
    const p = buildHeroImagePrompt("Demo Org", "Potluck");
    expect(p).toContain("Potluck");
    expect(p).toContain("no text");
  });
});
