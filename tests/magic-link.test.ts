import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSixDigitCode,
  generateMagicLinkToken,
  generateSixDigitCode,
  MAGIC_LINK_LIFETIME_MS,
  renderMagicLinkEmail,
} from "../server/lib/magic-link.js";
import { verifyTurnstile } from "../server/lib/turnstile.js";
import { normalizeSixDigitCode, type InstanceConfig } from "@bulletinmail/shared";

const config: InstanceConfig = {
  apexDomain: "example.org",
  productName: "Example Lists",
  productNameShort: "Lists",
  tagline: "...",
  supportAddress: "support",
  abuseAddress: "abuse",
  dmarcAddress: "dmarc",
  noreplyAddress: "noreply",
  unsubscribeAddressPrefix: "unsubscribe+",
  archiveUrlTemplate: "https://example.org/g/{tenant}/{group}",
  unsubscribeUrlTemplate: "https://example.org/u/{token}",
  additionalReservedSlugs: [],
  minSlugLength: 3,
  maxSlugLength: 40,
  defaultDailyMessageLimitPerTenant: 1000,
  defaultMaxRecipientsPerGroup: 500,
  operator: { legalName: "Example Org", mailingAddress: "...", contactUrl: "..." },
  mailSubdomain: null,
  ai: { dailyGenerationCap: 20, textModel: "@cf/test/text-model", imageModel: "@cf/test/image-model" },
  features: {
    byoDomainEnabled: false, publicArchivesAllowed: true, signupSelfService: false, singleTenant: false,
    ai: { promoteToWiki: false, wikiAutogen: false, wikiHeroImages: false },
  },
};

describe("generateMagicLinkToken", () => {
  it("returns 64 hex characters", () => {
    const t = generateMagicLinkToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct tokens on each call", () => {
    const set = new Set(Array.from({ length: 32 }, () => generateMagicLinkToken()));
    expect(set.size).toBe(32);
  });
});

describe("MAGIC_LINK_LIFETIME_MS", () => {
  it("is 15 minutes", () => {
    expect(MAGIC_LINK_LIFETIME_MS).toBe(15 * 60 * 1000);
  });
});

describe("generateSixDigitCode", () => {
  it("returns exactly 6 numeric digits", () => {
    for (let i = 0; i < 64; i++) {
      const code = generateSixDigitCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("zero-pads small values", () => {
    // Patch crypto.getRandomValues so we can force the modulo result to a
    // small integer and confirm the zero-pad. We deliberately rebind the
    // method so the implementation's `new Uint32Array(1)` allocation still
    // works — we only have to fill the buffer.
    const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    try {
      globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(buf: T): T => {
        if (buf && buf instanceof Uint32Array) buf[0] = 42; // 42 % 1_000_000 === 42
        return buf;
      }) as typeof globalThis.crypto.getRandomValues;
      expect(generateSixDigitCode()).toBe("000042");
    } finally {
      globalThis.crypto.getRandomValues = original;
    }
  });

  it("returns varied codes across calls", () => {
    const set = new Set(Array.from({ length: 32 }, () => generateSixDigitCode()));
    // With a 1-in-a-million range, 32 random draws should hit nearly
    // 32 distinct values (collision odds are ~one-in-31_250).
    expect(set.size).toBeGreaterThanOrEqual(30);
  });
});

describe("formatSixDigitCode", () => {
  it("inserts a space at the midpoint", () => {
    expect(formatSixDigitCode("123456")).toBe("123 456");
    expect(formatSixDigitCode("000042")).toBe("000 042");
  });

  it("leaves non-6-digit input untouched", () => {
    expect(formatSixDigitCode("12345")).toBe("12345");
    expect(formatSixDigitCode("12 34 56")).toBe("12 34 56");
  });
});

describe("normalizeSixDigitCode", () => {
  it("round-trips the email's own formatting", () => {
    // The email renders formatSixDigitCode's "123 456" — a straight
    // copy/paste of what we sent must always normalize back.
    expect(normalizeSixDigitCode(formatSixDigitCode("123456"))).toBe("123456");
  });

  it("strips the plain-text body's leading indent", () => {
    // The text email indents the code with four spaces; sloppy selection
    // grabs them too.
    expect(normalizeSixDigitCode("    123 456")).toBe("123456");
    expect(normalizeSixDigitCode("123 456\n")).toBe("123456");
  });

  it("strips dashes and unicode spaces", () => {
    expect(normalizeSixDigitCode("123-456")).toBe("123456");
    expect(normalizeSixDigitCode("123 456")).toBe("123456"); // NBSP from HTML email copy
    expect(normalizeSixDigitCode("1 2 3 4 5 6")).toBe("123456");
  });

  it("does not fabricate validity", () => {
    // Callers still validate /^\d{6}$/ on the result.
    expect(normalizeSixDigitCode("12 345")).toBe("12345");
    expect(normalizeSixDigitCode("your code is 123 456!")).toBe("123456");
    expect(normalizeSixDigitCode("")).toBe("");
  });
});

describe("renderMagicLinkEmail", () => {
  const built = renderMagicLinkEmail({
    config,
    recipientEmail: "alice@example.com",
    tenantDisplayName: "Demo Org",
    verifyUrl: "https://app.example.org/auth/verify?token=abc",
  });

  it("sends from noreply on the apex", () => {
    expect(built.from).toBe("noreply@example.org");
  });

  it("addresses the recipient", () => {
    expect(built.to).toBe("alice@example.com");
  });

  it("subject includes product and tenant", () => {
    expect(built.subject).toContain("Example Lists");
    expect(built.subject).toContain("Demo Org");
  });

  it("text body contains the verify URL", () => {
    expect(built.text).toContain("https://app.example.org/auth/verify?token=abc");
  });

  it("html body contains an anchor to the verify URL", () => {
    expect(built.html).toContain(`href="https://app.example.org/auth/verify?token=abc"`);
  });

  it("HTML-escapes the tenant display name in the body", () => {
    const evil = renderMagicLinkEmail({
      config,
      recipientEmail: "alice@example.com",
      tenantDisplayName: "<script>alert(1)</script>",
      verifyUrl: "https://app.example.org/auth/verify?token=abc",
    });
    expect(evil.html).not.toContain("<script>alert(1)</script>");
    expect(evil.html).toContain("&#60;script&#62;");
  });

  it("omits the code section entirely when no code is provided", () => {
    expect(built.text).not.toMatch(/6-digit code/i);
    expect(built.html).not.toMatch(/6-digit code/i);
  });

  it("includes the formatted code in both text and html when supplied", () => {
    const withCode = renderMagicLinkEmail({
      config,
      recipientEmail: "alice@example.com",
      tenantDisplayName: "Demo Org",
      verifyUrl: "https://app.example.org/auth/verify?token=abc",
      code: "123456",
    });
    expect(withCode.text).toContain("123 456");
    expect(withCode.text).toMatch(/6-digit code/i);
    expect(withCode.html).toContain("123 456");
    expect(withCode.html).toMatch(/6-digit code/i);
  });
});

describe("verifyTurnstile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bypasses when the secret is unset (dev mode)", async () => {
    const fetcher = vi.fn();
    const ok = await verifyTurnstile(undefined, "any-token", "1.2.3.4", fetcher as unknown as typeof fetch);
    expect(ok).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns false when the secret is set but the token is missing", async () => {
    const fetcher = vi.fn();
    const ok = await verifyTurnstile("s3cret", undefined, "1.2.3.4", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns false when siteverify reports success=false", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 }));
    const ok = await verifyTurnstile("s3cret", "bad-token", "1.2.3.4", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as Parameters<typeof fetch>;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init).toMatchObject({ method: "POST" });
    const body = (init as RequestInit).body as string;
    expect(body).toContain("secret=s3cret");
    expect(body).toContain("response=bad-token");
    expect(body).toContain("remoteip=1.2.3.4");
  });

  it("returns true when siteverify reports success=true", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const ok = await verifyTurnstile("s3cret", "good-token", "1.2.3.4", fetcher as unknown as typeof fetch);
    expect(ok).toBe(true);
  });

  it("returns false on a network error (does not silently bypass)", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network down"); });
    const ok = await verifyTurnstile("s3cret", "good-token", undefined, fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it("returns false on a non-2xx HTTP response", async () => {
    const fetcher = vi.fn(async () => new Response("oops", { status: 500 }));
    const ok = await verifyTurnstile("s3cret", "good-token", undefined, fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
  });
});
