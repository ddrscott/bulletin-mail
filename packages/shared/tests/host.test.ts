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

describe("classifyHost — single-tenant mode", () => {
  const cfg = { apexDomain: "example.org", singleTenant: true };

  it("treats the apex as tenant 'mail' (default slug equals default mailSubdomain)", () => {
    expect(classifyHost("example.org", cfg)).toEqual({ kind: "tenant", slug: "mail" });
  });

  it("strips the port and still maps to the default slug", () => {
    expect(classifyHost("example.org:8787", cfg)).toEqual({ kind: "tenant", slug: "mail" });
  });

  it("uses the configured mailSubdomain as the slug", () => {
    const customCfg = { apexDomain: "example.org", singleTenant: true, mailSubdomain: "lists" };
    expect(classifyHost("example.org", customCfg)).toEqual({ kind: "tenant", slug: "lists" });
  });

  it("classifier doesn't reject literal-subdomain shape (handler 404s instead)", () => {
    // Multi-tenant rules still apply at the classifier — the subdomain is a
    // tenant slug. In single-tenant deployments only one tenant row exists,
    // so anything other than that slug 404s downstream at lookup time.
    expect(classifyHost("anything.example.org", cfg)).toEqual({
      kind: "tenant",
      slug: "anything",
    });
  });

  it("rejects wrong apex", () => {
    expect(classifyHost("evil.com", cfg)).toEqual({ kind: "unknown" });
  });

  it("lowercases the host", () => {
    expect(classifyHost("Example.ORG", cfg)).toEqual({ kind: "tenant", slug: "mail" });
  });
});
