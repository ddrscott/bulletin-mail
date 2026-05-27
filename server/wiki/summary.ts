/**
 * AI-summarize wiki edits.
 *
 * Workflow (called from POST /api/wiki/:slug via ctx.waitUntil):
 *   1. Compute a unified diff between the previous and new markdown source.
 *   2. Send the diff to Workers AI with a "describe the change in 1–2
 *      sentences, fall back to 'Minor changes.' if unsure" system prompt.
 *   3. Trim the model output to ≤ 200 chars; on any error or empty/garbage
 *      output, fall back to "Minor changes."
 *   4. Write the summary back to versions.summary via a DO RPC. Failures
 *      log but never throw — the user's save already succeeded.
 *
 * The deterministic +N/-M line delta is always available to callers
 * (computeLineDelta) so the activity feed never depends on the AI text
 * for ground truth — the AI is a convenience layer on top.
 */

export const SUMMARY_FALLBACK = "Minor changes.";
export const SUMMARY_MAX_LEN = 200;

/**
 * Line-based unified diff with N lines of context. Pure JS, no deps —
 * the wiki page diffs are small (a few KB) and we just need a stable
 * representation to feed the LLM. Algorithm is LCS-based; for the
 * typical 100–1000 line wiki page this is plenty fast.
 *
 * Output mirrors `diff -U <context>`:
 *   --- previous
 *   +++ current
 *   @@ -oldStart,oldLen +newStart,newLen @@
 *    context line
 *   -removed line
 *   +added line
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  context = 3,
): string {
  const a = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");

  // No previous → treat all new lines as additions in one hunk.
  if (a.length === 0) {
    if (b.length === 0) return "";
    const header = `--- previous\n+++ current\n@@ -0,0 +1,${b.length} @@\n`;
    return header + b.map((l) => `+${l}`).join("\n") + "\n";
  }

  const ops = diffOps(a, b);
  if (ops.every((op) => op.kind === "eq")) return ""; // identical
  const hunks = groupHunks(ops, context);
  if (hunks.length === 0) return "";

  let out = "--- previous\n+++ current\n";
  for (const h of hunks) {
    const oldLen = h.lines.filter((l) => l[0] === " " || l[0] === "-").length;
    const newLen = h.lines.filter((l) => l[0] === " " || l[0] === "+").length;
    // Header uses 1-based line numbers; 0-length sides use 0.
    const oldStart = oldLen === 0 ? Math.max(0, h.oldStart) : h.oldStart + 1;
    const newStart = newLen === 0 ? Math.max(0, h.newStart) : h.newStart + 1;
    out += `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`;
    out += h.lines.join("\n") + "\n";
  }
  return out;
}

/** Count added / removed lines. Deterministic ground-truth signal. */
export function computeLineDelta(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const a = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  const ops = diffOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

// ---- LCS-based diff ---------------------------------------------------------

type Op =
  | { kind: "eq"; line: string; oldIdx: number; newIdx: number }
  | { kind: "del"; line: string; oldIdx: number }
  | { kind: "add"; line: string; newIdx: number };

function diffOps(a: string[], b: string[]): Op[] {
  // Build LCS length table. m × n cells, each a small int → fine for any
  // realistic wiki page (a 5000×5000 grid is 25M cells which is still under
  // a tenth of a second in v8 — and we'd never have a 5000-line wiki page).
  const m = a.length;
  const n = b.length;
  // Flat Int32Array for cache friendliness vs. nested arrays.
  const lcs = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        lcs[i * stride + j] = lcs[(i + 1) * stride + (j + 1)]! + 1;
      } else {
        const down = lcs[(i + 1) * stride + j]!;
        const right = lcs[i * stride + (j + 1)]!;
        lcs[i * stride + j] = down >= right ? down : right;
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i]!, oldIdx: i, newIdx: j });
      i++; j++;
    } else if (lcs[(i + 1) * stride + j]! >= lcs[i * stride + (j + 1)]!) {
      ops.push({ kind: "del", line: a[i]!, oldIdx: i });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]!, newIdx: j });
      j++;
    }
  }
  while (i < m) { ops.push({ kind: "del", line: a[i]!, oldIdx: i }); i++; }
  while (j < n) { ops.push({ kind: "add", line: b[j]!, newIdx: j }); j++; }
  return ops;
}

type Hunk = {
  oldStart: number; // 0-based
  newStart: number; // 0-based
  lines: string[];  // each starts with ' ', '-', or '+'
};

function groupHunks(ops: Op[], context: number): Hunk[] {
  const changedIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.kind !== "eq") changedIdx.push(k);
  }
  if (changedIdx.length === 0) return [];

  // Merge change indices into hunks: any two changes within 2*context of
  // each other share a hunk so their contexts overlap.
  const hunks: Hunk[] = [];
  let groupStart = changedIdx[0]!;
  let groupEnd = changedIdx[0]!;
  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k]!;
    if (idx - groupEnd > 2 * context) {
      hunks.push(buildHunk(ops, groupStart, groupEnd, context));
      groupStart = idx;
    }
    groupEnd = idx;
  }
  hunks.push(buildHunk(ops, groupStart, groupEnd, context));
  return hunks;
}

function buildHunk(ops: Op[], first: number, last: number, context: number): Hunk {
  const start = Math.max(0, first - context);
  const end = Math.min(ops.length - 1, last + context);
  const lines: string[] = [];
  let oldStart = -1;
  let newStart = -1;
  for (let k = start; k <= end; k++) {
    const op = ops[k]!;
    if (op.kind === "eq") {
      if (oldStart < 0) { oldStart = op.oldIdx; newStart = op.newIdx; }
      lines.push(` ${op.line}`);
    } else if (op.kind === "del") {
      if (oldStart < 0) { oldStart = op.oldIdx; }
      if (newStart < 0) {
        // Walk forward to find the first eq/add to anchor newStart.
        // Otherwise use the running "would-be" new index based on prior ops.
        newStart = newIndexAt(ops, k);
      }
      lines.push(`-${op.line}`);
    } else {
      if (newStart < 0) { newStart = op.newIdx; }
      if (oldStart < 0) { oldStart = oldIndexAt(ops, k); }
      lines.push(`+${op.line}`);
    }
  }
  if (oldStart < 0) oldStart = 0;
  if (newStart < 0) newStart = 0;
  return { oldStart, newStart, lines };
}

function newIndexAt(ops: Op[], k: number): number {
  // Count added/eq ops before k to derive the new-side index.
  let n = 0;
  for (let i = 0; i < k; i++) {
    const op = ops[i]!;
    if (op.kind !== "del") n++;
  }
  return n;
}

function oldIndexAt(ops: Op[], k: number): number {
  let n = 0;
  for (let i = 0; i < k; i++) {
    const op = ops[i]!;
    if (op.kind !== "add") n++;
  }
  return n;
}

// ---- AI call ---------------------------------------------------------------

/**
 * Workers AI model id. Picked for fast + cheap + plenty of context for a
 * diff. Wrapped in a const so a future swap is one line.
 */
export const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = [
  "You summarize wiki page edits for a moderation review feed. You will see a",
  "unified diff of a Markdown wiki page. Describe in 1–2 short sentences what",
  "actually changed, in plain English, for a reviewer who hasn't seen the page.",
  "",
  "Rules:",
  "- Describe only edits you are confident about. If the diff is ambiguous,",
  "  consists only of whitespace, only formatting, or you cannot determine",
  "  intent — respond with exactly: Minor changes.",
  "- Do not speculate about author intent. Stick to observable changes.",
  "- Do not add commentary, opinions, or quality judgments.",
  "- Do not quote large chunks. Summarize.",
  "- Maximum 200 characters total.",
].join("\n");

/**
 * Minimal shape of the AI binding we use. The full `Ai` type ships with
 * @cloudflare/workers-types but pulling it in everywhere bloats this
 * module's type surface. The runtime call uses `ai.run(model, input)`.
 */
export type AiBindingLike = {
  run: (
    model: string,
    input: unknown,
  ) => Promise<unknown>;
};

/**
 * Trim and sanitize model output. Returns the fallback for anything that
 * looks wrong — empty string, error markers, or content longer than the
 * cap (we hard-trim instead of letting "The author updated…" runs run).
 */
export function normalizeSummary(raw: unknown): string {
  if (typeof raw !== "string") return SUMMARY_FALLBACK;
  // Strip surrounding whitespace and quote marks the model sometimes adds.
  let s = raw.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!s) return SUMMARY_FALLBACK;
  // Collapse internal whitespace runs to single spaces — the feed renders
  // inline so multi-line summaries break the layout.
  s = s.replace(/\s+/g, " ");
  // Reject obvious refusal / disclaimer prefixes that the model sometimes
  // emits in spite of the system prompt.
  if (/^(i\b|as an ai\b|sorry\b|i'm|i am)/i.test(s)) return SUMMARY_FALLBACK;
  if (s.length > SUMMARY_MAX_LEN) s = s.slice(0, SUMMARY_MAX_LEN - 1).trimEnd() + "…";
  return s;
}

/**
 * Run the model on a unified diff and return a normalized summary. On any
 * failure (model error, missing binding, weird shape) returns the fallback.
 */
export async function generateSummary(
  ai: AiBindingLike,
  unifiedDiff: string,
): Promise<string> {
  if (!unifiedDiff.trim()) return SUMMARY_FALLBACK;
  try {
    const result = await ai.run(SUMMARY_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "```diff\n" + unifiedDiff + "```" },
      ],
      max_tokens: 120,
    });
    // Workers AI llama family returns { response: string } for text-generation.
    const text =
      (result as { response?: unknown })?.response ??
      (result as { result?: { response?: unknown } })?.result?.response;
    return normalizeSummary(text);
  } catch (err) {
    console.error("wiki summary AI call failed", err);
    return SUMMARY_FALLBACK;
  }
}
