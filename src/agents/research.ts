import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import type { ArticleCandidate, NewsletterConfig } from "./types";

// A real wall-clock budget for the whole search, not a per-call timeout
// guessed at from the outside. Ported from a proven pattern (a separate,
// working job-search agent - see docs/R2_BUILD-SPEC.md M2 for the story of
// what didn't work before this): loop, extract+accumulate results after
// every completed response, and when the budget runs out, return whatever's
// been found - never an error just because the model wanted to keep looking.
const TIME_BUDGET_MS = 3 * 60 * 1000;

const SYSTEM_PROMPT = `You are the Research agent in an automated AI newsletter pipeline for product managers.
Your only job is to find recent, relevant news articles using the web_search tool and report them as structured data.
Do not summarize in depth or make the final relevance call - that is the Curator agent's job. Just find good candidates.

After each batch of searches, output any candidates found so far as a raw JSON array - even if you plan to keep
searching. In later turns, output the full updated list. This ensures results are captured even if the search
stops early.`;

function buildUserPrompt(config: NewsletterConfig): string {
  return `Search for AI news published in the last 2 days that would matter to a product manager, on these topics: ${config.topics}

Look for things like: new AI products or features, new AI capabilities, how companies are making money with AI, new AI regulation, and how AI is changing jobs/skills.

Critical: for every result, find the DIRECT article URL - never a publication homepage, a search results page, or a generic section page. If a search result only gives you an aggregator or homepage link, open it and find the real article URL before including it.

Format (no markdown fences, no surrounding text):
[{"title": string, "source": string, "url": string, "snippet": string}]

"snippet" should be 1-2 factual sentences describing what the article actually covers - other agents will rely on it without re-reading the article.

Find between 5 and 12 candidates if they exist. If you genuinely find nothing relevant, output an empty array: []`;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      err.name === "APIUserAbortError" ||
      err.name === "APIConnectionError" ||
      err.message === "Request was aborted.")
  );
}

// Non-throwing, unlike lib/json.ts's extractJson - a response with no
// parseable JSON just contributes zero candidates for this round rather
// than halting the whole search. Checks text blocks from last to first,
// since the model may add a "still searching..." remark after its JSON.
function extractCandidates(response: Anthropic.Message): ArticleCandidate[] {
  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");

  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const text = textBlocks[i].text.trim();

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as ArticleCandidate[];
    } catch {
      // fall through to bracket-matching below
    }

    let idx = 0;
    while (idx < text.length) {
      const start = text.indexOf("[", idx);
      if (start === -1) break;
      let depth = 0;
      let end = -1;
      for (let j = start; j < text.length; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end !== -1) {
        try {
          const candidate = JSON.parse(text.slice(start, end + 1));
          if (Array.isArray(candidate)) return candidate as ArticleCandidate[];
        } catch {
          // try the next '[' in this text block
        }
      }
      idx = start + 1;
    }
  }

  return [];
}

export async function runResearchAgent(config: NewsletterConfig): Promise<ArticleCandidate[]> {
  const startMs = Date.now();
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: buildUserPrompt(config) }];

  const allCandidates: ArticleCandidate[] = [];
  const seenUrls = new Set<string>();
  function merge(incoming: ArticleCandidate[]) {
    for (const candidate of incoming) {
      if (candidate.url && !seenUrls.has(candidate.url)) {
        allCandidates.push(candidate);
        seenUrls.add(candidate.url);
      }
    }
  }

  let iteration = 0;
  while (true) {
    iteration++;
    const elapsed = Date.now() - startMs;
    console.log(
      `[research] iteration ${iteration}, elapsed ${(elapsed / 1000).toFixed(1)}s, found so far: ${allCandidates.length}`
    );

    if (elapsed >= TIME_BUDGET_MS) {
      console.log(`[research] time budget exhausted - returning ${allCandidates.length} candidate(s)`);
      break;
    }

    const remainingMs = TIME_BUDGET_MS - elapsed;

    try {
      const response = await anthropic.messages.create(
        {
          model: AGENT_MODEL,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          tools: [{ type: "web_search_20260318", name: "web_search" }],
          messages,
        },
        { signal: AbortSignal.timeout(remainingMs), maxRetries: 0 }
      );

      console.log(
        `[research] call completed at ${((Date.now() - startMs) / 1000).toFixed(1)}s, stop_reason: ${response.stop_reason}`
      );

      const newCandidates = extractCandidates(response);
      console.log(`[research] extracted ${newCandidates.length} candidate(s) from this response`);
      merge(newCandidates);

      if (response.stop_reason === "end_turn") {
        break;
      }

      // pause_turn: a long tool-use turn was paused, not finished.
      // max_tokens: cut off mid-generation rather than finished naturally.
      // Both get resumed the same way - ask for the full updated list, then
      // keep searching if there's still budget left.
      if (response.stop_reason === "pause_turn" || response.stop_reason === "max_tokens") {
        messages = [
          ...messages,
          { role: "assistant", content: response.content },
          {
            role: "user",
            content:
              "Continue searching. Output the full updated JSON array of all candidates found so far, then keep searching for more if useful.",
          },
        ];
        continue;
      }

      break;
    } catch (err) {
      if (isAbortError(err)) {
        console.log(
          `[research] aborted at ${((Date.now() - startMs) / 1000).toFixed(1)}s - returning ${allCandidates.length} candidate(s) found so far`
        );
        break;
      }
      throw err;
    }
  }

  console.log(`[research] done: ${allCandidates.length} total candidate(s)`);
  return allCandidates;
}
