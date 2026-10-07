import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJsonFromResponse } from "../lib/json";
import type { ArticleCandidate, NewsletterConfig } from "./types";

const SYSTEM_PROMPT = `You are the Curator agent in an automated AI newsletter pipeline for product managers.
You do not search the web - you only judge candidates you're given. Filter for genuine relevance, remove duplicates, and rank by importance to a PM audience.`;

function buildUserPrompt(config: NewsletterConfig, candidates: ArticleCandidate[]): string {
  const indexed = candidates.map((c, index) => ({ index, ...c }));

  return `Newsletter topics: ${config.topics}
Newsletter voice: ${config.voice}

Here are today's candidate articles as JSON, each with its index in this list:
${JSON.stringify(indexed, null, 2)}

From these:
1. Remove anything that isn't genuinely relevant to a product manager (not just AI-adjacent - it should matter for someone building or managing a product).
2. Remove duplicates - if two candidates cover the same story, keep only the stronger one.
3. Rank the survivors most-important-first. The first article should be the most interesting and attention-grabbing.
4. Keep the best 3 to 7. Fewer than 3 is fine if that's all that qualifies.

Reply with ONLY a JSON array of the "index" values (not the full objects) of the candidates you're keeping, ordered most-important-first - e.g. [2, 0, 4]. Don't retype title/source/url/snippet; just reference them by index.

If nothing qualifies, reply with an empty array: []`;
}

export async function runCuratorAgent(
  config: NewsletterConfig,
  candidates: ArticleCandidate[]
): Promise<ArticleCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    // A list of indices is tiny compared to re-typed article objects - no
    // realistic truncation risk, but kept well above what's needed anyway.
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(config, candidates) }],
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
