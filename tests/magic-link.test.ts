import { describe, expect, it } from "vitest";
import {
  generateMagicLinkToken,
  MAGIC_LINK_LIFETIME_MS,
  renderMagicLinkEmail,
} from "../server/lib/magic-link.js";
import type { InstanceConfig } from "@bulletinmail/shared";

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
  features: { byoDomainEnabled: false, publicArchivesAllowed: true, signupSelfService: false },
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
});
