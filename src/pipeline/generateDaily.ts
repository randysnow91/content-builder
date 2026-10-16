import { runCuratorAgent } from "../agents/curator";
import { runResearchAgent } from "../agents/research";
import { runReviewerAgent } from "../agents/reviewer";
import { runWriterAgent } from "../agents/writer";
import type { ArticleCandidate, NewsletterConfig, WriterOutput } from "../agents/types";
import type { Block, IssuePayload, ReviewerFlag } from "../lib/issue-schema";
import { collectSentArticles, normalizeUrl } from "./sentArticles";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Wraps a pipeline stage with elapsed-time logging so a slow run can be
// diagnosed from the logs alone - which stage was slow - rather than
// guessed at (this is exactly what was missing when a Research call ran
// past 10 minutes during M2 testing).
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[pipeline] ${label} took ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
}

// Pure data transform, no API calls - kept separate from the orchestration
// below so the zero-articles fallback (docs/R2_BUILD-SPEC.md M1) can be
// checked directly against a synthetic WriterOutput, without needing a real
// (and non-deterministic) live run that happens to find nothing.
export function buildDailyBlocks(written: WriterOutput): Block[] {
  const blocks: Block[] = [];

  if (written.articles.length === 0) {
    blocks.push({
      kind: "text",
      heading: "🔍 No Articles Today",
      body: "We didn't find any relevant AI news for product managers today.",
    });
  } else {
    for (const article of written.articles) {
      blocks.push({
        kind: "article_card",
        emoji: article.emoji,
        title: article.title,
        source: article.source,
        summary: article.summary,
        pmPerspective: article.pmPerspective,
        url: article.url,
      });
    }
  }

  blocks.push({
    kind: "closing_thought",
    heading: written.closingThought.heading,
    body: written.closingThought.body,
  });

  return blocks;
}

// Drops any candidate whose link already went out in a recent email. Done in
// code, before the Curator, so an exact repeat can never get through - not
// even on the Curator-failed fallback path below. A repeat under a different
// link (the same story from another outlet) is the Curator's job instead.
// Pure, so it can be checked directly.
export function removeAlreadySent(candidates: ArticleCandidate[], sentUrls: Set<string>): ArticleCandidate[] {
  return candidates.filter((c) => !sentUrls.has(normalizeUrl(c.url)));
}

// Wires Research -> Curator -> Writer -> Reviewer into one daily IssuePayload
// (docs/R2_BUILD-SPEC.md M1-M2). Each agent is its own, separate API call -
// this function does no LLM calls of its own, just plain orchestration.
// `recentContent` is the newsletter's recent sent dailies, passed in by the
// Conductor, so today's email doesn't repeat a story readers already got
// (found in real data, 2026-10-15). Empty means no check - the same output
// as before this existed.
export async function generateDailyIssue(
  config: NewsletterConfig,
  recentContent: IssuePayload[] = []
): Promise<IssuePayload> {
  const recent = collectSentArticles(recentContent);
  const sentUrls = new Set(recent.map((a) => normalizeUrl(a.url)));
  console.log(`[pipeline] Daily: ${recent.length} recently sent article(s) to avoid repeating`);

  // "Always return something, never just error out" (decided 2026-09-18):
  // a Research failure - the 8-minute timeout, a parsing error, anything -
  // degrades to the same "no articles found" path already built and
  // verified for a genuinely empty search result (M1), rather than a raw
  // 500. The failure is still logged loudly, just not fatal to the request.
  let candidates: ArticleCandidate[];
  try {
    candidates = await timed("Research", () => runResearchAgent(config));
    console.log(`[pipeline] Research found ${candidates.length} candidate(s)`);
    const fresh = removeAlreadySent(candidates, sentUrls);
    if (fresh.length < candidates.length) {
      console.log(`[pipeline] Removed ${candidates.length - fresh.length} candidate(s) already sent recently`);
    }
    candidates = fresh;
  } catch (err) {
    console.error(`[pipeline] Research failed, falling back to zero candidates: ${(err as Error).message}`);
    candidates = [];
  }

  // Same principle as Research above: a Curator hiccup (e.g. its own JSON
  // reply getting cut off - seen 2026-09-18 once Research started returning
  // more candidates than before) shouldn't lose everything Research found.
  // Falling back to the raw, uncurated candidates (capped at 7, matching
  // Curator's own normal ceiling) is a worse newsletter than a properly
  // curated one, but a far better outcome than an error.
  let curated: ArticleCandidate[];
  try {
    curated = await timed("Curator", () => runCuratorAgent(config, candidates, recent));
    console.log(`[pipeline] Curator kept ${curated.length} of ${candidates.length} candidate(s)`);
  } catch (err) {
    console.error(`[pipeline] Curator failed, falling back to uncurated candidates: ${(err as Error).message}`);
    curated = candidates.slice(0, 7);
  }

  let written: WriterOutput;
  try {
    written = await timed("Writer", () => runWriterAgent(config, curated));
    console.log(
      `[pipeline] Writer produced ${written.articles.length} article(s), dropped ${written.droppedArticles.length}`
    );
  } catch (err) {
    console.error(`[pipeline] Writer failed, falling back to no articles: ${(err as Error).message}`);
    written = {
      articles: [],
      droppedArticles: [],
      closingThought: {
        heading: "💡 Useful Thought for Today",
        body: "Today's digest couldn't be generated - a good day to revisit your own product's roadmap instead.",
      },
    };
  }

  // A curated article Writer couldn't produce valid content for (missing-URL
  // handoff, 2026-10-04) is dropped rather than let through half-formed, but
  // surfaced here so the operator sees it and it blocks auto-send, same as
  // any other Reviewer finding (architecture doc §11.5).
  const droppedFlags: ReviewerFlag[] = written.droppedArticles.map((dropped) => ({
    type: "dropped_article",
    articleUrl: dropped.url,
    message: `"${dropped.title}" was selected but couldn't be fully written: ${dropped.reason}`,
  }));

  const reviewerFlags =
    written.articles.length > 0 ? await timed("Reviewer", () => runReviewerAgent(written.articles)) : [];
  reviewerFlags.push(...droppedFlags);
  console.log(`[pipeline] Reviewer raised ${reviewerFlags.length} flag(s)`);

  return {
    type: "daily",
    date: todayIsoDate(),
    blocks: buildDailyBlocks(written),
    reviewerFlags,
  };
}
