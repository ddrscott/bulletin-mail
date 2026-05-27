import { describe, expect, it } from "vitest";
import { parseBulkEmails } from "../src/worker/routes/admin/members.js";

describe("parseBulkEmails", () => {
  it("returns empty for empty input", () => {
    expect(parseBulkEmails("")).toEqual({ valid: [], invalid: [] });
    expect(parseBulkEmails("   \n\n  ")).toEqual({ valid: [], invalid: [] });
  });

  it("parses one email per line", () => {
    expect(parseBulkEmails("alice@example.com\nbob@example.com")).toEqual({
      valid: ["alice@example.com", "bob@example.com"],
      invalid: [],
    });
  });

  it("strips Name <email> wrapping", () => {
    expect(parseBulkEmails('Alice <alice@example.com>\n"Bob Q." <bob@example.com>')).toEqual({
      valid: ["alice@example.com", "bob@example.com"],
      invalid: [],
    });
  });

  it("splits on commas and semicolons within a line", () => {
    expect(parseBulkEmails("alice@example.com, bob@example.com; carol@example.com")).toEqual({
      valid: ["alice@example.com", "bob@example.com", "carol@example.com"],
      invalid: [],
    });
  });

  it("lowercases addresses", () => {
    expect(parseBulkEmails("Alice@Example.COM")).toEqual({
      valid: ["alice@example.com"],
      invalid: [],
    });
  });

  it("dedupes within input", () => {
    expect(parseBulkEmails("alice@example.com\nALICE@example.com\nalice@example.com")).toEqual({
      valid: ["alice@example.com"],
      invalid: [],
    });
  });

  it("separates invalid tokens", () => {
    expect(parseBulkEmails("alice@example.com\nnot-an-email\nbob@example.com")).toEqual({
      valid: ["alice@example.com", "bob@example.com"],
      invalid: ["not-an-email"],
    });
  });

  it("tolerates Windows line endings", () => {
    expect(parseBulkEmails("alice@example.com\r\nbob@example.com\r\n")).toEqual({
      valid: ["alice@example.com", "bob@example.com"],
      invalid: [],
    });
  });
});
