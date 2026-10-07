import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJsonFromResponse } from "../lib/json";
import type { ArticleCandidate, DroppedArticle, NewsletterConfig, WriterOutput, WrittenArticle } from "./types";

const SYSTEM_PROMPT = `You are the Writer agent in an automated AI newsletter pipeline for product managers.
You do not search the web or decide what's relevant - you write. For each article you're given, write a tight summary
and a PM perspective. You also write one closing thought for the whole issue.`;

function buildUserPrompt(config: NewsletterConfig, articles: ArticleCandidate[]): string {
  const indexed = articles.map((a, index) => ({ index, ...a }));

  return `Newsletter voice: ${config.voice}

Here are today's curated articles, most important first, each with its index in this list, as JSON:
${JSON.stringify(indexed, null, 2)}

For EACH article, write:
- "index": the article's index from the list above, unchanged
- "emoji": one emoji that captures the article's topic
- "summary": 2-3 sentences, concise and factual, based on the snippet you were given
- "pmPerspective": 2-3 sentences on what this means for product teams - strategy, competition, user behavior, or business impact. Not a restatement of the summary.

Don't retype title/source/url - just reference each article by its index; the surrounding code already has those fields.

Then write one "closingThought": a heading (e.g. "💡 Useful Thought for Today") and a body of 1-2 practical, concrete sentences a PM could use today. Tie it to one of the articles if you can; otherwise a generally useful PM idea. If you were given zero articles, still write a closing thought - a generic useful idea about product management.

Write in this voice: ${config.voice}

Reply with ONLY a JSON object (no markdown code fences, no other text) in this exact shape:
{"articles": [{"index": number, "emoji": string, "summary": string, "pmPerspective": string}], "closingThought": {"heading": string, "body": string}}`;
}

type RawWriterArticle = {
  index: number;
  emoji: string;
  summary: string;
  pmPerspective: string;
};

type RawWriterOutput = {
  articles: RawWriterArticle[];
  closingThought: { heading: string; body: string };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function runWriterAgent(
  config: NewsletterConfig,
  articles: ArticleCandidate[]
): Promise<WriterOutput> {
  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    // Some safety margin above Curator's own "3 to 7" cap - cheap insurance
    // against the same mid-JSON truncation found in Curator's output.
    max_tokens: 6144,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(config, articles) }],
  });

  const raw = extractJsonFromResponse<RawWriterOutput>(response, "Writer agent");

  // Merge title/source/url back in from the curated candidate the model was
  // given, rather than trusting a re-typed copy from the model (the actual
  // root cause of the missing-URL bug - docs/R2_BUILD-SPEC.md, handoff
  // 2026-10-04). A curated article Writer couldn't produce valid content for
  // (an out-of-range index, a missing required field, or no entry at all) is
  // dropped rather than let through half-formed - but never silently: it's
  // recorded in droppedArticles so generateDaily.ts can raise a flag the
  // operator actually sees.
  const seenIndices = new Set<number>();
  const written: WrittenArticle[] = [];
  const dropped: DroppedArticle[] = [];

  for (const entry of raw.articles ?? []) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= articles.length) {
      console.error(`[writer] ignoring out-of-range index ${entry.index}`);
      continue;
    }
    if (seenIndices.has(entry.index)) {
      console.error(`[writer] ignoring duplicate index ${entry.index}`);
      continue;
    }
    seenIndices.add(entry.index);

    const candidate = articles[entry.index];
    const missingFields = (["emoji", "summary", "pmPerspective"] as const).filter(
      (field) => !isNonEmptyString(entry[field])
    );

    if (missingFields.length > 0) {
      dropped.push({
        url: candidate.url,
        title: candidate.title,
        reason: `Writer did not produce: ${missingFields.join(", ")}`,
      });
      continue;
    }

    written.push({
      emoji: entry.emoji,
      title: candidate.title,
      source: candidate.source,
      summary: entry.summary,
      pmPerspective: entry.pmPerspective,
      url: candidate.url,
    });
  }

  // A curated article Writer never addressed at all (no entry, not even an
  // incomplete one) is just as much a silent loss as a malformed one.
  articles.forEach((candidate, index) => {
    if (!seenIndices.has(index)) {
      dropped.push({ url: candidate.url, title: candidate.title, reason: "Writer did not produce an entry for this article" });
    }
  });

  return { articles: written, droppedArticles: dropped, closingThought: raw.closingThought };
}
