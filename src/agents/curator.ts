import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJson } from "../lib/json";
import type { ArticleCandidate, NewsletterConfig } from "./types";

const SYSTEM_PROMPT = `You are the Curator agent in an automated AI newsletter pipeline for product managers.
You do not search the web - you only judge candidates you're given. Filter for genuine relevance, remove duplicates, and rank by importance to a PM audience.`;

function buildUserPrompt(config: NewsletterConfig, candidates: ArticleCandidate[]): string {
  return `Newsletter topics: ${config.topics}
Newsletter voice: ${config.voice}

Here are today's candidate articles as JSON:
${JSON.stringify(candidates, null, 2)}

From these:
1. Remove anything that isn't genuinely relevant to a product manager (not just AI-adjacent - it should matter for someone building or managing a product).
2. Remove duplicates - if two candidates cover the same story, keep only the stronger one.
3. Rank the survivors most-important-first. The first article should be the most interesting and attention-grabbing.
4. Keep the best 3 to 7. Fewer than 3 is fine if that's all that qualifies.

Reply with ONLY a JSON array (no markdown code fences, no other text) of the chosen candidates, using the exact same shape you were given:
[{"title": string, "source": string, "url": string, "snippet": string}]

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
    // Raised from 2048: with Research now able to return more candidates
    // (its own time-budgeted loop can accumulate across several search
    // rounds), Curator's echoed-back JSON for a larger input list could get
    // cut off mid-string before finishing.
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(config, candidates) }],
  });

  const finalText = response.content.find((block) => block.type === "text")?.text;
  if (!finalText) {
    throw new Error("Curator agent returned no text content to parse");
  }

  return extractJson<ArticleCandidate[]>(finalText);
}
