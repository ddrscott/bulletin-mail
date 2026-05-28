import { describe, expect, it } from "vitest";
import {
  archiveUrl,
  ConfigError,
  loadFromEnv,
  mailHost,
  singleTenantSlug,
  systemAddress,
  unsubscribeMailto,
  unsubscribeUrl,
} from "../src/config.js";

const fullEnv = {
  INSTANCE_APEX_DOMAIN: "example.org",
  INSTANCE_PRODUCT_NAME: "Example Lists",
  INSTANCE_PRODUCT_NAME_SHORT: "Lists",
  INSTANCE_TAGLINE: "tag",
  INSTANCE_ARCHIVE_URL: "https://example.org/g/{tenant}/{group}",
  INSTANCE_UNSUB_URL: "https://example.org/u/{token}",
  INSTANCE_OPERATOR_LEGAL_NAME: "Example Org",
  INSTANCE_OPERATOR_MAILING_ADDRESS: "123 Main",
  INSTANCE_OPERATOR_CONTACT_URL: "https://example.org/contact",
};

describe("loadFromEnv", () => {
  it("loads with defaults filled in", () => {
    const cfg = loadFromEnv(fullEnv);
    expect(cfg.apexDomain).toBe("example.org");
    expect(cfg.supportAddress).toBe("support");
    expect(cfg.features.signupSelfService).toBe(false);
    expect(cfg.minSlugLength).toBe(3);
  });

  it("parses CSV reserved slugs", () => {
    const cfg = loadFromEnv({ ...fullEnv, INSTANCE_RESERVED_SLUGS: "foo, bar,baz" });
    expect(cfg.additionalReservedSlugs).toEqual(["foo", "bar", "baz"]);
  });

  it("throws on missing required field", () => {
    const { INSTANCE_APEX_DOMAIN: _, ...broken } = fullEnv;
    expect(() => loadFromEnv(broken)).toThrow(ConfigError);
  });

  it("throws on non-numeric numeric field", () => {
    expect(() => loadFromEnv({ ...fullEnv, INSTANCE_MIN_SLUG_LENGTH: "abc" })).toThrow(
      ConfigError,
    );
  });
});

describe("url helpers", () => {
  const cfg = loadFromEnv(fullEnv);

  it("interpolates archiveUrl", () => {
    expect(archiveUrl(cfg, "firstpresby", "announcements")).toBe(
      "https://example.org/g/firstpresby/announcements",
    );
  });

  it("interpolates unsubscribeUrl", () => {
    expect(unsubscribeUrl(cfg, "abc123")).toBe("https://example.org/u/abc123");
  });

  it("builds unsubscribe mailto", () => {
    expect(unsubscribeMailto(cfg, "abc123")).toBe("unsubscribe+abc123@example.org");
  });

  it("builds system addresses", () => {
    expect(systemAddress(cfg, "support")).toBe("support@example.org");
    expect(systemAddress(cfg, "abuse")).toBe("abuse@example.org");
    expect(systemAddress(cfg, "dmarc")).toBe("dmarc@example.org");
    expect(systemAddress(cfg, "noreply")).toBe("noreply@example.org");
  });
});

describe("mailSubdomain", () => {
  it("defaults to null when unset, with mailHost == apex", () => {
    const cfg = loadFromEnv(fullEnv);
    expect(cfg.mailSubdomain).toBe(null);
    expect(mailHost(cfg)).toBe("example.org");
  });

  it("loads from INSTANCE_MAIL_SUBDOMAIN and routes system mail through it", () => {
    const cfg = loadFromEnv({ ...fullEnv, INSTANCE_MAIL_SUBDOMAIN: "mail" });
    expect(cfg.mailSubdomain).toBe("mail");
    expect(mailHost(cfg)).toBe("mail.example.org");
    expect(systemAddress(cfg, "noreply")).toBe("noreply@mail.example.org");
    expect(unsubscribeMailto(cfg, "tok")).toBe("unsubscribe+tok@mail.example.org");
  });

  it("treats empty string the same as unset (null)", () => {
    const cfg = loadFromEnv({ ...fullEnv, INSTANCE_MAIL_SUBDOMAIN: "" });
    expect(cfg.mailSubdomain).toBe(null);
    expect(mailHost(cfg)).toBe("example.org");
  });
});

describe("singleTenantSlug", () => {
  it("returns null in multi-tenant mode", () => {
    const cfg = loadFromEnv(fullEnv);
    expect(singleTenantSlug(cfg)).toBe(null);
  });

  it("defaults to 'mail' in single-tenant mode", () => {
    const cfg = loadFromEnv({ ...fullEnv, INSTANCE_FEATURE_SINGLE_TENANT: "true" });
    expect(singleTenantSlug(cfg)).toBe("mail");
  });

  it("respects the configured mailSubdomain in single-tenant mode", () => {
    const cfg = loadFromEnv({
      ...fullEnv,
      INSTANCE_FEATURE_SINGLE_TENANT: "true",
      INSTANCE_MAIL_SUBDOMAIN: "lists",
    });
    expect(singleTenantSlug(cfg)).toBe("lists");
  });
});
