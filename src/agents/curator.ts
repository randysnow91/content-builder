import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJsonFromResponse } from "../lib/json";
import type { ArticleCandidate, NewsletterConfig, WeeklyArticle } from "./types";

const SYSTEM_PROMPT = `You are the Curator agent in an automated AI newsletter pipeline for product managers.
You do not search the web - you only judge candidates you're given. Filter for genuine relevance, remove duplicates, and rank by importance to a PM audience.`;

// What already went out recently, for spotting the same story told by a
// different outlet (an exact repeat of a link is already removed in code,
// generateDaily.ts). Title and summary are enough to recognize a story; the
// PM Perspective and URL would only be noise here.
function recentSection(recent: WeeklyArticle[]): string {
  if (recent.length === 0) return "";
  const listed = recent.map((a) => ({ date: a.date, title: a.title, source: a.source, summary: a.summary }));
  return `
These stories already went out in this newsletter's recent emails, as JSON:
${JSON.stringify(listed, null, 2)}
`;
}

function buildUserPrompt(config: NewsletterConfig, candidates: ArticleCandidate[], recent: WeeklyArticle[]): string {
  const indexed = candidates.map((c, index) => ({ index, ...c }));

  const steps = [
    "Remove anything that isn't genuinely relevant to a product manager (not just AI-adjacent - it should matter for someone building or managing a product).",
    "Remove duplicates - if two candidates cover the same story, keep only the stronger one.",
    ...(recent.length > 0
      ? [
          "Remove any candidate about a story that already went out (listed above), even from a different outlet, with a different headline, or leading with a different detail or angle - readers have already seen it. Keep it only if it reports a separate, later event (e.g. a launch that was only announced is now actually available, a deal closed, a ruling came down). New details, analysis, reactions, or a wider rollout of the same release don't count. When unsure, leave it out.",
        ]
      : []),
    "Rank the survivors most-important-first. The first article should be the most interesting and attention-grabbing.",
    "Keep the best 3 to 7. Fewer than 3 is fine if that's all that qualifies.",
  ];

  return `Newsletter topics: ${config.topics}
Newsletter voice: ${config.voice}
${recentSection(recent)}
Here are today's candidate articles as JSON, each with its index in this list:
${JSON.stringify(indexed, null, 2)}

From these:
${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}

Reply with ONLY a JSON array of the "index" values (not the full objects) of the candidates you're keeping, ordered most-important-first - e.g. [2, 0, 4]. Don't retype title/source/url/snippet; just reference them by index.

If nothing qualifies, reply with an empty array: []`;
}

export async function runCuratorAgent(
  config: NewsletterConfig,
  candidates: ArticleCandidate[],
  recent: WeeklyArticle[] = []
): Promise<ArticleCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    // The reply itself is tiny (a list of indices), but the model thinks
    // first, and that counts too: ~750-800 tokens once it's also comparing
    // against the recent stories, and one replay run hit the old 1024 limit
    // with no answer at all (2026-10-16). Same headroom as the Reviewer.
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(config, candidates, recent) }],
  });

  const indices = extractJsonFromResponse<number[]>(response, "Curator agent");

  // Map indices back to the original candidates rather than trusting
  // re-typed JSON from the model (the actual root cause of the missing-URL
  // bug - docs/R2_BUILD-SPEC.md, handoff 2026-10-04): title/source/url/
  // snippet never pass through the model at all for this stage, so they
  // can't be dropped or mangled here. An out-of-range or duplicate index
  // isn't a real candidate being lost - just discard it (logged) rather
  // than fail the whole stage over it.
  const seen = new Set<number>();
  const kept: ArticleCandidate[] = [];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      console.error(`[curator] ignoring out-of-range index ${index}`);
      continue;
    }
    if (seen.has(index)) {
      console.error(`[curator] ignoring duplicate index ${index}`);
      continue;
    }
    seen.add(index);
    kept.push(candidates[index]);
  }

  return kept;
}
