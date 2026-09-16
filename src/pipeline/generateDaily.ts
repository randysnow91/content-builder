import { runCuratorAgent } from "../agents/curator";
import { runResearchAgent } from "../agents/research";
import { runWriterAgent } from "../agents/writer";
import type { NewsletterConfig, WriterOutput } from "../agents/types";
import type { Block, IssuePayload } from "../lib/issue-schema";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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

// Wires Research -> Curator -> Writer into one daily IssuePayload
// (docs/R2_BUILD-SPEC.md M1). Each agent is its own, separate API call -
// this function does no LLM calls of its own, just plain orchestration.
export async function generateDailyIssue(config: NewsletterConfig): Promise<IssuePayload> {
  const candidates = await runResearchAgent(config);
  console.log(`[pipeline] Research found ${candidates.length} candidate(s)`);

  const curated = await runCuratorAgent(config, candidates);
  console.log(`[pipeline] Curator kept ${curated.length} of ${candidates.length} candidate(s)`);

  const written = await runWriterAgent(config, curated);
  console.log(`[pipeline] Writer produced ${written.articles.length} article(s)`);

  return {
    type: "daily",
    date: todayIsoDate(),
    blocks: buildDailyBlocks(written),
  };
}
