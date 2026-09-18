import type Anthropic from "@anthropic-ai/sdk";
import { runUntilDone } from "../lib/agentTurn";
import { AGENT_MODEL } from "../lib/config";
import { extractJson } from "../lib/json";
import type { ArticleCandidate, NewsletterConfig } from "./types";

const SYSTEM_PROMPT = `You are the Research agent in an automated AI newsletter pipeline for product managers.
Your only job is to find recent, relevant news articles using the web_search tool and report them as structured data.
Do not summarize in depth or make the final relevance call - that is the Curator agent's job. Just find good candidates.`;

function buildUserPrompt(config: NewsletterConfig): string {
  return `Search for AI news published in the last 2 days that would matter to a product manager, on these topics: ${config.topics}

Look for things like: new AI products or features, new AI capabilities, how companies are making money with AI, new AI regulation, and how AI is changing jobs/skills.

Critical: for every result, find the DIRECT article URL - never a publication homepage, a search results page, or a generic section page. If a search result only gives you an aggregator or homepage link, open it and find the real article URL before including it.

When you're done searching, reply with ONLY a JSON array (no markdown code fences, no other text) of the candidates you found, in this shape:
[{"title": string, "source": string, "url": string, "snippet": string}]

"snippet" should be 1-2 factual sentences describing what the article actually covers - other agents will rely on it without re-reading the article.

Find between 5 and 12 candidates if they exist. If you genuinely find nothing relevant, reply with an empty array: []`;
}

export async function runResearchAgent(config: NewsletterConfig): Promise<ArticleCandidate[]> {
  const response = await runUntilDone(
    {
      model: AGENT_MODEL,
      // Raised from 8192: with 15-20+ search results accumulating as
      // context, the tool-use/result content itself eats into this budget
      // before the model ever writes its final JSON answer.
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          // A hint, not a hard API-enforced ceiling in practice (confirmed
          // 2026-09-18: real runs used 17+ successful searches regardless
          // of this value). There's no safe way to cut a turn off mid-tool-
          // use once it exceeds this (see agentTurn.ts's header comment for
          // what was tried and why it was reverted) - the timeout below is
          // the real backstop, and generateDaily.ts falls back gracefully
          // if this whole call fails for any reason.
          max_uses: 10,
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(config) }],
    },
    // Real web-search turns can legitimately run well past the client's
    // default timeout. Give this one call a much longer ceiling, and don't
    // retry it - if it's slow because of genuine search work, retrying
    // just doubles the wait without fixing anything. If it still doesn't
    // converge in 8 minutes, that's a real, rare failure the pipeline
    // catches and degrades from gracefully rather than one more retry.
    { timeout: 8 * 60 * 1000, maxRetries: 0 }
  );

  const finalText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .at(-1)?.text;

  if (!finalText) {
    throw new Error(
      `Research agent returned no text content to parse (stop_reason: ${response.stop_reason}, block types: ${response.content.map((b) => b.type).join(", ")})`
    );
  }

  return extractJson<ArticleCandidate[]>(finalText);
}
