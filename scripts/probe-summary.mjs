#!/usr/bin/env node
/**
 * Prompt-tuning harness for the wiki edit summary feature.
 *
 * Calls Cloudflare Workers AI directly (REST) with the same model the prod
 * Worker uses, and prints the model output for each test case. Run with:
 *
 *   node scripts/probe-summary.mjs              # all cases, current prompt
 *   node scripts/probe-summary.mjs --prompt v2  # try alternate prompt
 *
 * Reads OAuth bearer token from ~/Library/Preferences/.wrangler/config/default.toml.
 * Account ID hardcoded to bulletinmail.org's CF account.
 *
 * Cleanup: delete this file once the prompt is tuned and live.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ACCOUNT_ID = "0223b96fe77599b23ff8ec7fcd32e2f1";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ---- Auth -------------------------------------------------------------------

function loadBearer() {
  const env = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (env) return env;
  const path = `${homedir()}/Library/Preferences/.wrangler/config/default.toml`;
  const toml = readFileSync(path, "utf8");
  const m = /oauth_token\s*=\s*"([^"]+)"/.exec(toml);
  if (!m) throw new Error(`no oauth_token in ${path}`);
  return m[1];
}

// ---- Prompts ----------------------------------------------------------------

const PROMPTS = {
  // The current production prompt.
  v1_current: [
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
  ].join("\n"),

  // v2 — encourages describing even small changes. The line-delta is always
  // shown next to the summary, so 'Minor changes.' is the WORST possible
  // answer for any non-empty diff (it adds no signal beyond the delta).
  // The fallback now only fires for genuinely-unintelligible diffs.
  // Also explicitly bans first-person prefixes so normalizeSummary doesn't
  // false-positive on them.
  v2_describe: [
    "You write a one-sentence summary of a change made to a Markdown wiki page,",
    "for a moderation review feed. The reviewer will see your summary alongside",
    "a line-count delta (+N/-M). Your job is to describe WHAT changed in plain",
    "English so the reviewer knows whether to investigate further.",
    "",
    "Rules:",
    "- Describe the change directly. Start with a verb when possible (Added,",
    "  Removed, Renamed, Updated, Reordered, Fixed a typo in, etc.).",
    "- Do NOT start with first-person language (I, I'm, As an AI).",
    "- Do NOT add commentary, opinions, or quality judgments.",
    "- Do NOT quote large chunks. Summarize.",
    "- Maximum 180 characters. One sentence preferred; two short ones OK.",
    "- If the diff is literally empty or only whitespace, reply with exactly:",
    "  Minor changes.",
    "- Even small changes (one word, one paragraph, one bullet) should be",
    "  described — the reviewer already knows the line count, so 'Minor changes.'",
    "  adds no information when there is any visible content change.",
  ].join("\n"),
};

// ---- Test cases -------------------------------------------------------------

// Each case is an OBJECT with a label + a unified diff. The diffs are what the
// prod Worker actually sends to the model.

const CASES = [
  {
    label: "smoke-test addition (the failing case from production)",
    diff: `--- previous
+++ current
@@ -1,7 +1,9 @@
 # Index

 Welcome to the wiki. Use **[[Page Name]]** to create or link to other pages — they'll show up as red links until you create them.

 ## Getting started

+Hello from smoke test — the time is 2026-05-27 15:51
+
 - Edit this page to introduce your organization.
`,
    expect: "describe — adding a paragraph to the page that says 'Hello from smoke test...'",
  },
  {
    label: "added a Contact section with phone + email",
    diff: `--- previous
+++ current
@@ -3,3 +3,8 @@
 ## Hours

 We are open Monday through Friday, 9am to 5pm.
+
+## Contact
+
+Phone: 555-1234
+Email: info@firstpresby.example
`,
    expect: "describe — added a Contact section with phone and email",
  },
  {
    label: "removed a sentence",
    diff: `--- previous
+++ current
@@ -1,5 +1,3 @@
 # About

-We were founded in 1985.
-
 Our mission is to serve the community.
`,
    expect: "describe — removed 'We were founded in 1985.'",
  },
  {
    label: "trivial whitespace + punctuation tweak",
    diff: `--- previous
+++ current
@@ -1,3 +1,3 @@
-# Welcome
+# Welcome!

 Body
`,
    expect: "Minor changes. (just added an exclamation point to the heading)",
  },
  {
    label: "renamed a section heading",
    diff: `--- previous
+++ current
@@ -3,3 +3,3 @@
-## Our Hours
+## Office Hours

 Monday-Friday 9-5.
`,
    expect: "describe — renamed the 'Our Hours' heading to 'Office Hours'",
  },
];

// ---- Run --------------------------------------------------------------------

async function callModel(bearer, system, diff) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "```diff\n" + diff + "```" },
      ],
      max_tokens: 120,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  // CF AI envelope: { result: { response: "..." }, success: true, ... }
  return json?.result?.response ?? json?.response ?? "<no response field>";
}

async function main() {
  const promptKey = process.argv[2]?.startsWith("--prompt=")
    ? process.argv[2].slice(9)
    : "v1_current";
  const prompt = PROMPTS[promptKey];
  if (!prompt) {
    console.error(`unknown prompt: ${promptKey}; available: ${Object.keys(PROMPTS).join(", ")}`);
    process.exit(2);
  }
  const bearer = loadBearer();

  console.log(`\n=== prompt: ${promptKey} ===\n`);
  console.log(`--- system message ---\n${prompt}\n`);

  for (const c of CASES) {
    process.stdout.write(`\n--- ${c.label} ---\n`);
    process.stdout.write(`expect:  ${c.expect}\n`);
    try {
      const out = await callModel(bearer, prompt, c.diff);
      process.stdout.write(`output:  ${out.trim()}\n`);
    } catch (err) {
      process.stdout.write(`ERROR:   ${err.message}\n`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
