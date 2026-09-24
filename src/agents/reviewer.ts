import { anthropic } from "../lib/anthropicClient";
import { AGENT_MODEL } from "../lib/config";
import { embedTexts } from "../lib/embeddings";
import { extractJson } from "../lib/json";
import { checkArticleLink } from "../lib/linkCheck";
import { retrieveRelevantPractices } from "../lib/ragCorpus";
import type { ReviewerFlag } from "../lib/issue-schema";
import type { WrittenArticle } from "./types";

const MAX_ARTICLE_TEXT_CHARS = 6000;

const SYSTEM_PROMPT = `You are the Reviewer agent in an automated AI newsletter pipeline for product managers.
For this check, you only judge factual accuracy: does the given summary and PM perspective actually reflect what's in the
real article text you're given? You are not judging writing quality, PM soundness, or anything else - only whether they
misrepresent the source. If a summary makes a claim the article doesn't support, or gets a fact wrong, flag it.`;

const PRACTICE_SYSTEM_PROMPT = `You are the Reviewer agent in an automated AI newsletter pipeline for product managers.
For this check, you only judge whether each PM Perspective reflects sound, grounded product-management thinking -
based ONLY on the retrieved practice documents given to you as context, not your own general opinion. You are not
judging factual accuracy or writing quality - only whether the perspective clearly conflicts with one or more of the
retrieved practices (e.g. pure hype with no user grounding, an unacknowledged risk one of the practices calls out,
restating the article with no independent analysis). The bar is "does not clearly violate a retrieved practice," not
"is this perfect" - most reasonable perspectives should NOT be flagged.`;

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

type ArticleWithRetrievedPractices = {
  articleUrl: string;
  pmPerspective: string;
  retrievedPractices: string[];
};

function buildPracticeUserPrompt(articles: ArticleWithRetrievedPractices[]): string {
  return `Here are today's PM Perspectives, each paired with the practice documents retrieved as most relevant to it:

${JSON.stringify(articles, null, 2)}

For each one, decide whether the PM Perspective clearly conflicts with one or more of its retrieved practices. Reply with ONLY a JSON array (no markdown code fences, no other text) listing ONLY the ones that conflict, in this shape:
[{"articleUrl": string, "message": string}]

"message" should name the specific practice it conflicts with and briefly explain why, written for a human reviewer who hasn't seen the retrieved documents.

If every PM Perspective is reasonably aligned with its retrieved practices, reply with an empty array: []`;
}

// M3's real RAG check (docs/R2_BUILD-SPEC.md M3, architecture doc §11.1):
// embed each PM Perspective, vector-search the pm_practices corpus, judge
// alignment grounded in what was actually retrieved - not an unsupported
// opinion. Runs independently of the link/accuracy checks (a broken link
// doesn't disqualify an article's PM Perspective from this check).
// Exported for direct testing (same rationale as buildDailyBlocks in
// generateDaily.ts) - lets the practice-alignment check be verified against
// a synthetic good/bad PM Perspective without needing a live article fetch.
export async function checkPracticeAlignment(articles: WrittenArticle[]): Promise<ReviewerFlag[]> {
  if (articles.length === 0) return [];

  // One batched embeddings call for all articles, not one call per article -
  // Voyage's free tier (no payment method on file) rate-limits to 3
  // requests/minute, and a real newsletter can have 5+ articles. Batching
  // keeps this to one request regardless of article count.
  const embeddings = await embedTexts(
    articles.map((article) => article.pmPerspective),
    "query"
  );

  const withPractices: ArticleWithRetrievedPractices[] = await Promise.all(
    articles.map(async (article, i) => {
      const retrieved = await retrieveRelevantPractices(embeddings[i]);
      console.log(
        `[reviewer] practice check for "${article.title}" retrieved: ${retrieved
          .map((p) => `"${p.content.slice(0, 60)}..." (similarity ${p.similarity.toFixed(3)})`)
          .join("; ")}`
      );
      return {
        articleUrl: article.url,
        pmPerspective: article.pmPerspective,
        retrievedPractices: retrieved.map((p) => p.content),
      };
    })
  );

  const response = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 2048,
    system: PRACTICE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPracticeUserPrompt(withPractices) }],
  });

  const finalText = response.content.find((block) => block.type === "text")?.text;
  if (!finalText) {
    throw new Error("Reviewer agent (practice check) returned no text content to parse");
  }

  const conflicting = extractJson<{ articleUrl: string; message: string }[]>(finalText);
  return conflicting.map((flag) => ({
    type: "practice_alignment" as const,
    articleUrl: flag.articleUrl,
    message: flag.message,
  }));
}

// The Reviewer's three checks (docs/R2_BUILD-SPEC.md M2/M3): link validity
// (plain fetch, no AI), summary accuracy (one Anthropic call, grounded in
// the page text that same fetch returned), and practice alignment (RAG
// against the pm_practices corpus). The practice check is wrapped in its own
// try/catch - a Voyage/Supabase hiccup should drop that one check, not fail
// the whole Reviewer stage (docs/R2_BUILD-SPEC.md §4.3's "degrade, don't
// error" principle, applied to the newest and most network-dependent check).
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

  try {
    const practiceFlags = await checkPracticeAlignment(articles);
    flags.push(...practiceFlags);
  } catch (err) {
    console.error(`[reviewer] Practice-alignment check failed, skipping it: ${(err as Error).message}`);
  }

  return flags;
}
