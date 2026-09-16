import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { extractJson } from "../lib/json";
import { checkArticleLink } from "../lib/linkCheck";
import type { ReviewerFlag } from "../lib/issue-schema";
import type { WrittenArticle } from "./types";

const MAX_ARTICLE_TEXT_CHARS = 6000;

const SYSTEM_PROMPT = `You are the Reviewer agent in an automated AI newsletter pipeline for product managers.
For this check, you only judge factual accuracy: does the given summary and PM perspective actually reflect what's in the
real article text you're given? You are not judging writing quality, PM soundness, or anything else - only whether they
misrepresent the source. If a summary makes a claim the article doesn't support, or gets a fact wrong, flag it.`;

type ArticleForAccuracyCheck = {
  articleUrl: string;
  title: string;
  summary: string;
  pmPerspective: string;
  articleText: string;
};

function buildUserPrompt(articles: ArticleForAccuracyCheck[]): string {
  return `Here are today's articles, each with its written summary/PM perspective and the real article text fetched from its URL:

${JSON.stringify(articles, null, 2)}

For each article, decide if the summary and PM perspective are an accurate reflection of the article text. Reply with ONLY a JSON array (no markdown code fences, no other text) listing ONLY the ones that are inaccurate, in this shape:
[{"articleUrl": string, "message": string}]

"message" should briefly explain what's wrong (e.g. what the summary claims vs. what the article actually says), written for a human reviewer who hasn't read the article.

If every article's summary and PM perspective accurately reflect their article text, reply with an empty array: []`;
}

async function checkSummaryAccuracy(articles: ArticleForAccuracyCheck[]): Promise<ReviewerFlag[]> {
  if (articles.length === 0) return [];

  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(articles) }],
  });

  const finalText = response.content.find((block) => block.type === "text")?.text;
  if (!finalText) {
    throw new Error("Reviewer agent returned no text content to parse");
  }

  const inaccurate = extractJson<{ articleUrl: string; message: string }[]>(finalText);
  return inaccurate.map((flag) => ({
    type: "inaccurate_summary" as const,
    articleUrl: flag.articleUrl,
    message: flag.message,
  }));
}

// The Reviewer's two mechanical checks (docs/R2_BUILD-SPEC.md M2): link
// validity (plain fetch, no AI) and summary accuracy (one Anthropic call,
// grounded in the page text that same fetch returned). The RAG-based
// PM-practices check is M3 - not built here.
export async function runReviewerAgent(articles: WrittenArticle[]): Promise<ReviewerFlag[]> {
  const flags: ReviewerFlag[] = [];
  const linkResults = await Promise.all(articles.map((article) => checkArticleLink(article.url)));

  const articlesToCheck: ArticleForAccuracyCheck[] = [];

  articles.forEach((article, i) => {
    const result = linkResults[i];
    if (!result.ok) {
      flags.push({ type: "broken_link", articleUrl: article.url, message: result.reason });
      return;
    }
    articlesToCheck.push({
      articleUrl: article.url,
      title: article.title,
      summary: article.summary,
      pmPerspective: article.pmPerspective,
      articleText: result.text.slice(0, MAX_ARTICLE_TEXT_CHARS),
    });
  });

  const accuracyFlags = await checkSummaryAccuracy(articlesToCheck);
  flags.push(...accuracyFlags);

  return flags;
}
