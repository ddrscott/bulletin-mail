/**
 * LLM extras (community hub 5/5) — promote-to-wiki, red-link autogen, and
 * hero images. Everything here is dark by default:
 *
 *   - Each feature has its own `features.ai.*` flag in the instance config,
 *     all defaulting to false.
 *   - A flag alone is not enough: the Worker must also carry the `AI`
 *     binding. `enabledAiFeatures()` folds both conditions, so callers can
 *     hide UI and 404 routes with one check — no broken buttons, and zero
 *     Workers AI calls when off.
 *   - Every generation call first consumes one unit of the tenant's daily
 *     budget (`consumeAiBudget` in @bulletinmail/db, cap from
 *     `config.ai.dailyGenerationCap`).
 *   - Model ids come from `config.ai.*`, never hard-coded, so operators can
 *     track Workers AI model deprecations in their overlay.
 *
 * The promote flow NEVER saves — it renders the wiki editor prefilled with
 * the draft, and a human reviews/edits/saves. Autogen saves a first draft
 * (cf-wiki's original behavior) with an explicit "AI-generated" revision
 * note; the trigger is a POST from a signed-in editor, never a bare GET on
 * a red link (crawlers and prefetchers must not burn budget).
 */

import type { InstanceConfig } from "@bulletinmail/shared";
import type { AiBindingLike } from "../wiki/summary.js";

export type AiFeatureSet = {
  promoteToWiki: boolean;
  wikiAutogen: boolean;
  wikiHeroImages: boolean;
};

/**
 * Resolve which AI features are actually usable on this request: the
 * instance flag must be on AND the Workers AI binding must exist. When the
 * binding is absent every feature reads false, so UI hides entirely.
 */
export function enabledAiFeatures(
  config: Pick<InstanceConfig, "features">,
  ai: unknown,
): AiFeatureSet {
  const bound = Boolean(ai);
  const flags = config.features.ai;
  return {
    promoteToWiki: bound && flags.promoteToWiki,
    wikiAutogen: bound && flags.wikiAutogen,
    wikiHeroImages: bound && flags.wikiHeroImages,
  };
}

/** Uniform "limit reached" copy — shown wherever a generation is refused. */
export function aiLimitMessage(cap: number): string {
  return `Daily AI generation limit reached (${cap} calls per day for your organization). Try again tomorrow, or ask the instance operator to raise ai.dailyGenerationCap.`;
}

// ---- text generation --------------------------------------------------------

/** Cap on prompt material (thread bodies, page context) fed to the model. */
export const GEN_INPUT_MAX_CHARS = 12000;

/** Cap on generated markdown we accept — runaway outputs get trimmed. */
export const GEN_OUTPUT_MAX_CHARS = 20000;

export const PROMOTE_SYSTEM_PROMPT = [
  "You turn a mailing-list discussion thread into a DRAFT wiki page for a",
  "small community organization. The reader of the wiki page was not on the",
  "thread — write durable reference material, not meeting minutes.",
  "",
  "Rules:",
  "- Output ONLY the markdown body of the page. No preamble, no code fence",
  "  around the whole document, no 'Here is...' lead-in.",
  "- Start with a single # H1 title.",
  "- Distill decisions, how-tos, and facts. Drop greetings, signatures,",
  "  quoted reply chains, and scheduling back-and-forth.",
  "- Attribute nothing to individuals; write in the organization's neutral",
  "  voice.",
  "- Prefer short sections with ## headings and bullet lists.",
  "- If the thread contains contradictory or unresolved points, add a final",
  "  '## Open questions' section listing them honestly.",
].join("\n");

export const AUTOGEN_SYSTEM_PROMPT = [
  "You write the FIRST DRAFT of a missing wiki page for a small community",
  "organization's wiki. You are given the page title, the organization's",
  "name, and a list of pages that already exist.",
  "",
  "Rules:",
  "- Output ONLY the markdown body. No preamble, no code fence around the",
  "  whole document, no 'Here is...' lead-in.",
  "- Start with a single # H1 title.",
  "- Write 2-5 short sections of genuinely useful scaffolding for the topic:",
  "  what belongs on this page, sensible headings, placeholder checklists.",
  "- Where an EXISTING page from the provided list is relevant, link it with",
  "  [[Page Title]] wiki-link syntax (double square brackets, exact title).",
  "  You may also seed one or two [[links]] to obviously-useful pages that",
  "  do not exist yet.",
  "- Do not invent specific facts (dates, names, addresses, amounts). Use",
  "  clearly-marked placeholders like '(add date)' instead.",
  "- Keep it under 400 words. This is a starting point for a human editor.",
].join("\n");

export type ThreadMessageForPrompt = {
  fromLabel: string;
  receivedAt: number;
  body: string;
};

/**
 * Flatten a thread into the user prompt for promote-to-wiki. Messages are
 * included oldest-first; total size is capped so a monster thread can't
 * blow the model context (later messages get truncated away — the opening
 * posts carry the substance in practice).
 */
export function buildPromotePrompt(
  subject: string,
  messages: ThreadMessageForPrompt[],
): string {
  const parts: string[] = [`Thread subject: ${subject}`, ""];
  let used = parts[0]!.length;
  for (const [i, m] of messages.entries()) {
    const when = new Date(m.receivedAt).toISOString().slice(0, 10);
    const block = `--- Message ${i + 1} (${m.fromLabel}, ${when}) ---\n${m.body.trim()}\n`;
    if (used + block.length > GEN_INPUT_MAX_CHARS) {
      parts.push(`(${messages.length - i} later message(s) omitted for length)`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}

/** User prompt for red-link autogen. */
export function buildAutogenPrompt(
  orgName: string,
  pageTitle: string,
  existingTitles: string[],
): string {
  const list = existingTitles.slice(0, 50).map((t) => `- ${t}`).join("\n");
  return [
    `Organization: ${orgName}`,
    `Missing page title: ${pageTitle}`,
    "",
    "Existing wiki pages:",
    list || "(none yet)",
  ].join("\n").slice(0, GEN_INPUT_MAX_CHARS);
}

/**
 * Footer appended to every promoted draft so the wiki page cites its source
 * thread permalink. Kept out of the LLM's hands — the link must be exact.
 */
export function promoteSourceFooter(threadId: string, subject: string): string {
  const label = subject.trim() || "(no subject)";
  // [[...]] is wiki-link syntax; plain markdown link keeps the /t/ path.
  return `\n\n---\n\n*Source: promoted from the mailing-list thread [${label.replace(/[[\]]/g, "")}](/t/${threadId}).*\n`;
}

/**
 * Run a text-generation model and return trimmed markdown, or null on any
 * failure (model error, refusal-shaped emptiness, non-string response).
 * Callers surface a friendly retry message on null — never a stack trace.
 */
export async function generateMarkdown(
  ai: AiBindingLike,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const result = await ai.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
    });
    const text =
      (result as { response?: unknown })?.response ??
      (result as { result?: { response?: unknown } })?.result?.response;
    if (typeof text !== "string") return null;
    let md = text.trim();
    // Strip a whole-document code fence if the model wrapped its output.
    const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(md);
    if (fenced) md = fenced[1]!.trim();
    if (!md) return null;
    if (md.length > GEN_OUTPUT_MAX_CHARS) md = md.slice(0, GEN_OUTPUT_MAX_CHARS);
    return md;
  } catch (err) {
    console.error("ai: markdown generation failed", err);
    return null;
  }
}

// ---- hero images ------------------------------------------------------------

/** Prompt template for a wiki hero image. Deliberately tame. */
export function buildHeroImagePrompt(orgName: string, pageTitle: string): string {
  return (
    `Warm, minimal editorial illustration for a community wiki page titled ` +
    `"${pageTitle}" (organization: ${orgName}). Flat shapes, muted palette, ` +
    `no text, no words, no letters, no logos, no people's faces.`
  );
}

/**
 * Run a text-to-image model and return PNG/JPEG bytes, or null on failure.
 * Handles the two Workers AI response shapes: `{ image: <base64> }` (flux
 * family) and a raw binary body (stable-diffusion family returns a
 * ReadableStream / ArrayBuffer).
 */
export async function generateImageBytes(
  ai: AiBindingLike,
  model: string,
  prompt: string,
): Promise<Uint8Array | null> {
  try {
    const result = await ai.run(model, { prompt });
    if (result instanceof Uint8Array) return result;
    if (result instanceof ArrayBuffer) return new Uint8Array(result);
    if (result && typeof (result as ReadableStream).getReader === "function") {
      const buf = await new Response(result as ReadableStream).arrayBuffer();
      return new Uint8Array(buf);
    }
    const b64 = (result as { image?: unknown })?.image;
    if (typeof b64 === "string" && b64.length > 0) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return null;
  } catch (err) {
    console.error("ai: image generation failed", err);
    return null;
  }
}
