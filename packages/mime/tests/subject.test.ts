import { describe, expect, it } from "vitest";
import { normalizeSubject } from "../src/subject.js";

describe("normalizeSubject — PRD §9.3 table", () => {
  const prefix = "[Announcements]";

  it("adds the prefix to a bare subject", () => {
    expect(normalizeSubject({ raw: "Service tomorrow", prefix })).toBe(
      "[Announcements] Service tomorrow",
    );
  });

  it("collapses a single Re: + duplicated prefix", () => {
    expect(
      normalizeSubject({ raw: "Re: [Announcements] Service tomorrow", prefix }),
    ).toBe("[Announcements] Re: Service tomorrow");
  });

  it("collapses repeated Re: and prefix into a single Re:", () => {
    expect(
      normalizeSubject({
        raw: "Re: [Announcements] Re: [Announcements] Foo",
        prefix,
      }),
    ).toBe("[Announcements] Re: Foo");
  });

  it("preserves Fwd:", () => {
    expect(normalizeSubject({ raw: "Fwd: [Announcements] Foo", prefix })).toBe(
      "[Announcements] Fwd: Foo",
    );
  });
});

describe("normalizeSubject — variants", () => {
  const prefix = "[Announcements]";

  it("handles uppercase RE:", () => {
    expect(normalizeSubject({ raw: "RE: Service tomorrow", prefix })).toBe(
      "[Announcements] Re: Service tomorrow",
    );
  });

  it("handles Re[2]: numbered variant", () => {
    expect(normalizeSubject({ raw: "Re[2]: Hello", prefix })).toBe(
      "[Announcements] Re: Hello",
    );
  });

  it("Re: trumps Fwd: when both present", () => {
    expect(normalizeSubject({ raw: "Re: Fwd: thread", prefix })).toBe(
      "[Announcements] Re: thread",
    );
  });

  it("handles FW: as a Forward variant", () => {
    expect(normalizeSubject({ raw: "FW: Memo", prefix })).toBe(
      "[Announcements] Fwd: Memo",
    );
  });

  it("works without a prefix", () => {
    expect(normalizeSubject({ raw: "Re: hi", prefix: null })).toBe("Re: hi");
  });

  it("trims runaway whitespace", () => {
    expect(
      normalizeSubject({ raw: "Re:   [Announcements]    Hi", prefix }),
    ).toBe("[Announcements] Re: Hi");
  });

  it("escapes regex metacharacters in the prefix", () => {
    expect(
      normalizeSubject({ raw: "[List] Re: [List] hi", prefix: "[List]" }),
    ).toBe("[List] Re: hi");
  });
});
