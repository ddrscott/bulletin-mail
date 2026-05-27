#!/usr/bin/env node
/**
 * Variance probe — run the same diff N times against the model to see how
 * often it falls back to "Minor changes." or starts with first-person prefixes
 * that our normalizeSummary() rejects as refusals.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ACCOUNT_ID = "0223b96fe77599b23ff8ec7fcd32e2f1";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const N = parseInt(process.argv[2] ?? "10", 10);

function loadBearer() {
  const path = `${homedir()}/Library/Preferences/.wrangler/config/default.toml`;
  const toml = readFileSync(path, "utf8");
  return /oauth_token\s*=\s*"([^"]+)"/.exec(toml)[1];
}

const SYSTEM = [
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
].join("\n");

const DIFF = `--- previous
+++ current
@@ -1,7 +1,9 @@
 # Index

 Welcome to the wiki. Use **[[Page Name]]** to create or link to other pages — they'll show up as red links until you create them.

 ## Getting started

+Hello from smoke test — the time is 2026-05-27 15:51
+
 - Edit this page to introduce your organization.
`;

async function call(bearer) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "```diff\n" + DIFF + "```" },
        ],
        max_tokens: 120,
      }),
    },
  );
  const j = await r.json();
  return (j?.result?.response ?? "").trim();
}

const REFUSAL_RE = /^(i\b|as an ai\b|sorry\b|i'm|i am)/i;

const bearer = loadBearer();
const counts = { fallback: 0, refusal: 0, good: 0 };
const samples = [];
for (let i = 0; i < N; i++) {
  const out = await call(bearer);
  samples.push(out);
  if (/^minor changes\.?$/i.test(out)) counts.fallback++;
  else if (REFUSAL_RE.test(out)) counts.refusal++;
  else counts.good++;
  process.stdout.write(`${(i + 1).toString().padStart(2)}: ${out.slice(0, 120)}\n`);
}
console.log("\nbreakdown:", counts);
console.log("good rate:", ((counts.good / N) * 100).toFixed(0) + "%");
