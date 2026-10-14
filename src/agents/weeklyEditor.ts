import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJsonFromResponse } from "../lib/json";
import type { ClosingThought, NewsletterConfig, WeeklyArticle } from "./types";

// The weekly's one agent (docs/R2_BUILD-SPEC.md M5). Unlike the daily, there's
// no Research/Curator step - the week's articles were already found, curated,
// written and reviewed when their dailies went out. This agent's only job is
// judgment across the whole week: which stories mattered most, what themes
// connect them, and what a PM should take away. The numbers (counts, busiest
// day, top sources) are deliberately computed in code instead
// (generateWeekly.ts) - counting is something code always gets right and a
// model sometimes doesn't.
const SYSTEM_PROMPT = `You are the Weekly Editor agent in an automated AI newsletter pipeline for product managers.
You do not search the web or write new article summaries. You're given every article that went out in this week's
daily emails, and your job is to look across the whole week: pick the stories that mattered most, find the themes
that connect them, and say what product teams should take away. Connect the dots - a weekly that just re-lists the
dailies adds nothing.`;

function buildUserPrompt(config: NewsletterConfig, articles: WeeklyArticle[]): string {
  // Only what the judgment needs - the URL stays out entirely, so there's
  // nothing for the model to retype (the missing-URL lesson, 2026-10-04).
  const indexed = articles.map((a, index) => ({
    index,
    date: a.date,
    title: a.title,
    source: a.source,
    summary: a.summary,
    pmPerspective: a.pmPerspective,
  }));

  return `Newsletter topics: ${config.topics}
Newsletter voice: ${config.voice}

Here is every article from this week's daily emails, each with its index in this list, as JSON:
${JSON.stringify(indexed, null, 2)}

Write:
- "topStories": the 3 to 5 most important stories of the week for product managers, most important first, each as {"index": number}. If there are fewer than 3 articles, include all of them. The same news sometimes appears more than once (different days or outlets) - pick only one article per story.
- "themes": 2 to 4 themes that connect several articles (e.g. product launches, regulation, funding and deals, infrastructure). Each is {"name": string, "description": string, "articleIndices": number[]} - "description" is 1-2 sentences on what happened across those articles, and "articleIndices" lists every article that belongs to the theme. A theme should usually span 2 or more articles.
- "insights": 2 to 3 key takeaways for product teams from the week as a whole, each 1-2 sentences. Each should change how a PM thinks about their own product or market - not a restatement of one article. Back each one with specifics from the articles.
- "closingThought": a heading (e.g. "💡 Useful Thought for the Week Ahead") and a body of 1-2 practical, concrete sentences a PM could act on next week.

Reference articles only by index - don't retype titles or URLs; the surrounding code already has them.

Write in this voice: ${config.voice}

Reply with ONLY a JSON object (no markdown code fences, no other text) in this exact shape:
{"topStories": [{"index": number}], "themes": [{"name": string, "description": string, "articleIndices": number[]}], "insights": [string], "closingThought": {"heading": string, "body": string}}`;
}

type RawWeeklyEditorOutput = {
  topStories?: { index: number }[];
  themes?: { name: string; description: string; articleIndices: number[] }[];
  insights?: string[];
  closingThought?: { heading: string; body: string };
};

export type WeeklyTheme = {
  name: string;
  description: string;
  articleCount: number;
};

export type WeeklyEditorOutput = {
  topStories: WeeklyArticle[];
  themes: WeeklyTheme[];
  insights: string[];
  closingThought: ClosingThought;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIndex(value: unknown, length: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;
}

export async function runWeeklyEditorAgent(
  config: NewsletterConfig,
  articles: WeeklyArticle[]
): Promise<WeeklyEditorOutput> {
  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    // The reply is small (indices plus a few short paragraphs), but the
    // Curator/Writer/Reviewer all hit max_tokens truncation once real
    // production input was bigger than local tests - same insurance here.
    max_tokens: 6144,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(config, articles) }],
  });

  const raw = extractJsonFromResponse<RawWeeklyEditorOutput>(response, "Weekly Editor agent");

  // Same index-merge pattern as Writer: the model picks by index, and the
  // real article (title, URL, the daily's own summary/perspective) comes
  // from what we gave it. An out-of-range or repeated index is ignored
  // rather than failing the whole weekly.
  const seen = new Set<number>();
  const topStories: WeeklyArticle[] = [];
  for (const entry of raw.topStories ?? []) {
    if (!isValidIndex(entry?.index, articles.length) || seen.has(entry.index)) {
      console.error(`[weeklyEditor] ignoring invalid or duplicate top-story index ${entry?.index}`);
      continue;
    }
    seen.add(entry.index);
    topStories.push(articles[entry.index]);
  }

  // The count shown next to each theme is computed here from the indices,
  // not taken from a number the model typed.
  const themes: WeeklyTheme[] = [];
  for (const theme of raw.themes ?? []) {
    if (!isNonEmptyString(theme?.name) || !isNonEmptyString(theme?.description)) continue;
    const indices = new Set((theme.articleIndices ?? []).filter((i) => isValidIndex(i, articles.length)));
    if (indices.size === 0) continue;
    themes.push({ name: theme.name, description: theme.description, articleCount: indices.size });
  }

  const insights = (raw.insights ?? []).filter(isNonEmptyString);

  if (!isNonEmptyString(raw.closingThought?.heading) || !isNonEmptyString(raw.closingThought?.body)) {
    throw new Error("Weekly Editor agent did not produce a closing thought");
  }

  return { topStories, themes, insights, closingThought: raw.closingThought };
}
