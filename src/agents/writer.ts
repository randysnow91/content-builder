import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJson } from "../lib/json";
import type { ArticleCandidate, NewsletterConfig, WriterOutput } from "./types";

const SYSTEM_PROMPT = `You are the Writer agent in an automated AI newsletter pipeline for product managers.
You do not search the web or decide what's relevant - you write. For each article you're given, write a tight summary
and a PM perspective. You also write one closing thought for the whole issue.`;

function buildUserPrompt(config: NewsletterConfig, articles: ArticleCandidate[]): string {
  return `Newsletter voice: ${config.voice}

Here are today's curated articles, most important first, as JSON:
${JSON.stringify(articles, null, 2)}

For EACH article, write:
- "emoji": one emoji that captures the article's topic
- "title": the article's title, as given
- "source": the publication name, as given
- "summary": 2-3 sentences, concise and factual, based on the snippet you were given
- "pmPerspective": 2-3 sentences on what this means for product teams - strategy, competition, user behavior, or business impact. Not a restatement of the summary.
- "url": the article's URL, as given, unchanged

Then write one "closingThought": a heading (e.g. "💡 Useful Thought for Today") and a body of 1-2 practical, concrete sentences a PM could use today. Tie it to one of the articles if you can; otherwise a generally useful PM idea. If you were given zero articles, still write a closing thought - a generic useful idea about product management.

Write in this voice: ${config.voice}

Reply with ONLY a JSON object (no markdown code fences, no other text) in this exact shape:
{"articles": [{"emoji": string, "title": string, "source": string, "summary": string, "pmPerspective": string, "url": string}], "closingThought": {"heading": string, "body": string}}`;
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

  const finalText = response.content.find((block) => block.type === "text")?.text;
  if (!finalText) {
    throw new Error("Writer agent returned no text content to parse");
  }

  return extractJson<WriterOutput>(finalText);
}
