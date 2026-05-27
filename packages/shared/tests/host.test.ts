import { describe, expect, it } from "vitest";
import { classifyHost, extractTenantSlug } from "../src/host.js";

const config = { apexDomain: "example.org" };

describe("classifyHost", () => {
  it("classifies the apex", () => {
    expect(classifyHost("example.org", config)).toEqual({ kind: "apex" });
  });

  it("strips the port", () => {
    expect(classifyHost("example.org:8787", config)).toEqual({ kind: "apex" });
  });

  it("classifies a tenant subdomain", () => {
    expect(classifyHost("firstpresby.example.org", config)).toEqual({
      kind: "tenant",
      slug: "firstpresby",
    });
  });

  it("treats former admin subdomain as a regular tenant slug post-collapse", () => {
    // 'app' is a 3-char slug; admin no longer has a dedicated host kind.
    // Reserved-slug enforcement happens at tenant-creation time, not in the
    // host classifier.
    expect(classifyHost("app.example.org", config)).toEqual({
      kind: "tenant",
      slug: "app",
    });
  });

  it("rejects multi-level subdomains", () => {
    expect(classifyHost("x.y.example.org", config)).toEqual({ kind: "unknown" });
  });

  it("rejects a wrong apex", () => {
    expect(classifyHost("evil.com", config)).toEqual({ kind: "unknown" });
  });

  it("rejects a substring of the apex (anti-spoof)", () => {
    expect(classifyHost("notexample.org", config)).toEqual({ kind: "unknown" });
  });

  it("lowercases the host", () => {
    expect(classifyHost("FirstPresby.Example.Org", config)).toEqual({
      kind: "tenant",
      slug: "firstpresby",
    });
  });
});

describe("extractTenantSlug", () => {
  it("returns the slug for a tenant host", () => {
    expect(extractTenantSlug("firstpresby.example.org", config)).toBe("firstpresby");
  });

  it("returns null for apex / unknown", () => {
    expect(extractTenantSlug("example.org", config)).toBeNull();
    expect(extractTenantSlug("evil.com", config)).toBeNull();
  });
});
