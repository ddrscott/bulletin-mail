import { describe, expect, it } from "vitest";
import { BASE_RESERVED_SLUGS, validateTenantSlug } from "../src/slug.js";

const policy = {
  minSlugLength: 3,
  maxSlugLength: 40,
  additionalReservedSlugs: [] as readonly string[],
};

describe("validateTenantSlug", () => {
  it("accepts a normal slug", () => {
    expect(validateTenantSlug("firstpresby", policy)).toEqual({
      ok: true,
      slug: "firstpresby",
    });
  });

  it("lowercases input", () => {
    expect(validateTenantSlug("FirstPresby", policy)).toEqual({
      ok: true,
      slug: "firstpresby",
    });
  });

  it("rejects too-short slugs", () => {
    const r = validateTenantSlug("ab", policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at least 3/);
  });

  it("rejects too-long slugs", () => {
    const r = validateTenantSlug("a".repeat(41), policy);
    expect(r.ok).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(validateTenantSlug("-foo", policy).ok).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(validateTenantSlug("foo-", policy).ok).toBe(false);
  });

  it("rejects underscores", () => {
    expect(validateTenantSlug("foo_bar", policy).ok).toBe(false);
  });

  it("rejects unicode", () => {
    expect(validateTenantSlug("café", policy).ok).toBe(false);
  });

  it("rejects every base reserved slug", () => {
    for (const reserved of BASE_RESERVED_SLUGS) {
      const r = validateTenantSlug(reserved, policy);
      expect(r.ok, `expected '${reserved}' to be rejected`).toBe(false);
    }
  });

  it("rejects per-instance reserved slugs", () => {
    const r = validateTenantSlug("custom", {
      ...policy,
      additionalReservedSlugs: ["custom"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/this instance/);
  });
});
