/**
 * Subject-prefix normalization. See PRD §9.3 for the input → output table.
 *
 * Algorithm:
 *   1. Strip every (case-insensitive) occurrence of the configured prefix.
 *   2. Iteratively strip Re:/Fwd: markers from the start, remembering whether
 *      a reply or forward marker was present anywhere.
 *   3. Re-emit as `<prefix> <Re:|Fwd:|> <cleaned subject>`.
 *
 * Re: trumps Fwd: when both are present (the message is now a reply, even if
 * the original was a forward) — matches Gmail/Apple Mail behavior.
 */

export type SubjectInput = {
  raw: string;
  prefix: string | null; // e.g. "[Announcements]" or null
};

// `Re:` plus the bracketed-count variant `Re[3]:` that some clients emit.
const REPLY_RE = /^re(\s*\[\s*\d+\s*\])?\s*:\s*/i;
const FORWARD_RE = /^fwd?\s*:\s*/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeSubject(input: SubjectInput): string {
  let s = input.raw.trim();

  const stripAllPrefix = (str: string): string => {
    if (!input.prefix) return str;
    const re = new RegExp(escapeRegex(input.prefix), "gi");
    return str.replace(re, " ").replace(/\s+/g, " ").trim();
  };

  s = stripAllPrefix(s);

  let hadReply = false;
  let hadForward = false;

  // Iteratively peel off leading markers — they can interleave with the
  // prefix in real-world mail. Loop until a pass changes nothing.
  let changed = true;
  while (changed) {
    changed = false;
    if (REPLY_RE.test(s)) {
      s = s.replace(REPLY_RE, "");
      hadReply = true;
      changed = true;
    }
    if (FORWARD_RE.test(s)) {
      s = s.replace(FORWARD_RE, "");
      hadForward = true;
      changed = true;
    }
    const beforePrefix = s;
    s = stripAllPrefix(s);
    if (s !== beforePrefix) changed = true;
  }

  s = s.trim();

  const marker = hadReply ? "Re: " : hadForward ? "Fwd: " : "";

  const out = input.prefix ? `${input.prefix} ${marker}${s}` : `${marker}${s}`;
  return out.trim();
}
