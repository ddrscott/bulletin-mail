import { describe, expect, it } from "vitest";
import {
  computeLineDelta,
  computeUnifiedDiff,
  generateSummary,
  normalizeSummary,
  SUMMARY_FALLBACK,
  SUMMARY_MAX_LEN,
  type AiBindingLike,
} from "../server/wiki/summary.js";

describe("computeLineDelta", () => {
  it("returns all-added when there is no previous content", () => {
    const d = computeLineDelta("", "a\nb\nc");
    expect(d).toEqual({ added: 3, removed: 0 });
  });

  it("returns all-removed when the new content is empty", () => {
    const d = computeLineDelta("a\nb\nc", "");
    expect(d).toEqual({ added: 0, removed: 3 });
  });

  it("returns zero counts for identical text", () => {
    const d = computeLineDelta("a\nb\nc", "a\nb\nc");
    expect(d).toEqual({ added: 0, removed: 0 });
  });

  it("counts inserts as added, not added+removed", () => {
    const d = computeLineDelta("a\nb\nc", "a\nb\nNEW\nc");
    expect(d).toEqual({ added: 1, removed: 0 });
  });

  it("counts a single-line change as +1/-1", () => {
    const d = computeLineDelta("a\nb\nc", "a\nB\nc");
    expect(d).toEqual({ added: 1, removed: 1 });
  });

  it("treats CRLF and LF equivalently", () => {
    const a = "a\r\nb\r\nc";
    const b = "a\nb\nc";
    expect(computeLineDelta(a, b)).toEqual({ added: 0, removed: 0 });
  });
});

describe("computeUnifiedDiff", () => {
  it("emits a single all-added hunk when there is no previous content", () => {
    const diff = computeUnifiedDiff("", "first line\nsecond line");
    expect(diff).toContain("--- previous");
    expect(diff).toContain("+++ current");
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff).toContain("+first line");
    expect(diff).toContain("+second line");
  });

  it("returns empty string for identical content", () => {
    const diff = computeUnifiedDiff("same\ntext", "same\ntext");
    expect(diff).toBe("");
  });

  it("emits a unified hunk with context for an inline change", () => {
    const oldText = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta";
    const newText = "alpha\nbeta\nGAMMA\ndelta\nepsilon\nzeta\neta";
    const diff = computeUnifiedDiff(oldText, newText, 2);
    // Context window of 2 around the changed line includes alpha/beta + delta/epsilon.
    expect(diff).toContain(" alpha");
    expect(diff).toContain(" beta");
    expect(diff).toContain("-gamma");
    expect(diff).toContain("+GAMMA");
    expect(diff).toContain(" delta");
    expect(diff).toContain(" epsilon");
    // 'eta' is more than 2 lines after the change → should be omitted.
    expect(diff).not.toContain(" eta");
  });

  it("merges nearby changes into one hunk when within 2x context", () => {
    const oldText = "a\nb\nc\nd\ne\nf\ng";
    const newText = "a\nB\nc\nd\ne\nF\ng";
    const diff = computeUnifiedDiff(oldText, newText, 3);
    // Two changes (B at line 2, F at line 6) are 4 lines apart → within 2*3 context, one hunk.
    const hunkCount = (diff.match(/@@ /g) ?? []).length;
    expect(hunkCount).toBe(1);
  });

  it("splits distant changes into multiple hunks", () => {
    const oldText =
      "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt";
    const newText =
      "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nT";
    const diff = computeUnifiedDiff(oldText, newText, 2);
    const hunkCount = (diff.match(/@@ /g) ?? []).length;
    expect(hunkCount).toBe(2);
  });
});

describe("normalizeSummary", () => {
  it("returns the fallback for non-string input", () => {
    expect(normalizeSummary(undefined)).toBe(SUMMARY_FALLBACK);
    expect(normalizeSummary(null)).toBe(SUMMARY_FALLBACK);
    expect(normalizeSummary({ response: "hi" })).toBe(SUMMARY_FALLBACK);
  });

  it("returns the fallback for empty / whitespace-only strings", () => {
    expect(normalizeSummary("")).toBe(SUMMARY_FALLBACK);
    expect(normalizeSummary("   \n\t  ")).toBe(SUMMARY_FALLBACK);
  });

  it("strips surrounding quote characters the model sometimes adds", () => {
    expect(normalizeSummary('"Added a new section about volunteering."'))
      .toBe("Added a new section about volunteering.");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(normalizeSummary("Added\n\na new\n  section.")).toBe("Added a new section.");
  });

  it("rejects refusal / disclaimer prefixes", () => {
    expect(normalizeSummary("I'm not sure what changed.")).toBe(SUMMARY_FALLBACK);
    expect(normalizeSummary("As an AI, I cannot speculate.")).toBe(SUMMARY_FALLBACK);
    expect(normalizeSummary("Sorry, the diff is unclear.")).toBe(SUMMARY_FALLBACK);
  });

  it("hard-trims output longer than the max length", () => {
    const long = "x".repeat(SUMMARY_MAX_LEN + 50);
    const out = normalizeSummary(long);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_LEN);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("generateSummary", () => {
  it("returns the fallback when the diff is empty", async () => {
    const ai: AiBindingLike = {
      run: async () => ({ response: "should not be called" }),
    };
    expect(await generateSummary(ai, "")).toBe(SUMMARY_FALLBACK);
    expect(await generateSummary(ai, "   \n  ")).toBe(SUMMARY_FALLBACK);
  });

  it("returns the model response on a successful call", async () => {
    const ai: AiBindingLike = {
      run: async () => ({ response: "Added a paragraph about Sunday school." }),
    };
    const out = await generateSummary(ai, "--- previous\n+++ current\n+Sunday school");
    expect(out).toBe("Added a paragraph about Sunday school.");
  });

  it("returns the fallback when the binding throws", async () => {
    const ai: AiBindingLike = {
      run: async () => { throw new Error("AI service down"); },
    };
    const out = await generateSummary(ai, "--- previous\n+++ current\n+x");
    expect(out).toBe(SUMMARY_FALLBACK);
  });

  it("returns the fallback when the response shape is unexpected", async () => {
    const ai: AiBindingLike = {
      run: async () => ({ unexpected: "shape" }),
    };
    const out = await generateSummary(ai, "--- previous\n+++ current\n+x");
    expect(out).toBe(SUMMARY_FALLBACK);
  });

  it("normalizes the response (refusal → fallback)", async () => {
    const ai: AiBindingLike = {
      run: async () => ({ response: "I can't tell what changed here." }),
    };
    const out = await generateSummary(ai, "--- previous\n+++ current\n+x");
    expect(out).toBe(SUMMARY_FALLBACK);
  });
});
