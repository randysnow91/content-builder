import { runWeeklyEditorAgent, type WeeklyEditorOutput } from "../agents/weeklyEditor";
import type { NewsletterConfig, WeeklyArticle } from "../agents/types";
import type { Block, IssuePayload } from "../lib/issue-schema";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// "2026-10-05" -> "Monday, Oct 5". Parsed as UTC so the weekday doesn't
// shift by a day depending on the server's timezone.
function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

// Pulls every article_card out of the week's sent dailies, in date order.
// Pure, so it can be checked directly against hand-made input. A malformed
// entry is skipped rather than rejecting the whole week, and an article that
// went out twice (same URL) is only counted once.
export function collectWeeklyArticles(weekContent: IssuePayload[]): WeeklyArticle[] {
  const byDate = [...weekContent]
    .filter((issue) => typeof issue?.date === "string" && Array.isArray(issue.blocks))
    .sort((a, b) => a.date.localeCompare(b.date));

  const seenUrls = new Set<string>();
  const articles: WeeklyArticle[] = [];
  for (const issue of byDate) {
    for (const block of issue.blocks) {
      if (block?.kind !== "article_card" || !block.url || seenUrls.has(block.url)) continue;
      seenUrls.add(block.url);
      articles.push({
        date: issue.date,
        emoji: block.emoji,
        title: block.title,
        source: block.source,
        summary: block.summary,
        pmPerspective: block.pmPerspective,
        url: block.url,
      });
    }
  }
  return articles;
}

export type WeeklyStats = {
  total: number;
  perDay: { date: string; count: number }[]; // date order
  busiestDay: { date: string; count: number } | null;
  topSources: { source: string; count: number }[]; // up to 5, most frequent first
};

export function computeWeeklyStats(articles: WeeklyArticle[]): WeeklyStats {
  const dayCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const article of articles) {
    dayCounts.set(article.date, (dayCounts.get(article.date) ?? 0) + 1);
    sourceCounts.set(article.source, (sourceCounts.get(article.source) ?? 0) + 1);
  }

  const perDay = [...dayCounts.entries()].map(([date, count]) => ({ date, count }));
  const busiestDay = perDay.reduce<WeeklyStats["busiestDay"]>(
    (best, day) => (best === null || day.count > best.count ? day : best),
    null
  );
  // A source that appeared once isn't a "top" source - five of those in a
  // row would just be noise in the snapshot.
  const topSources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, 5);

  return { total: articles.length, perDay, busiestDay, topSources };
}

function snapshotBlock(stats: WeeklyStats): Block {
  const lines = [`**${stats.total}** article${stats.total === 1 ? "" : "s"} this week`];
  if (stats.busiestDay) {
    lines.push(`Busiest day: **${formatDay(stats.busiestDay.date)}** (${stats.busiestDay.count})`);
  }
  if (stats.topSources.length > 0) {
    lines.push(`Top sources: ${stats.topSources.map((s) => `${s.source} (${s.count})`).join(", ")}`);
  }
  return { kind: "text", heading: "📊 Weekly Snapshot", body: lines.join("\n") };
}

// No links here - EmailServer's text blocks render only **bold** and line
// breaks (its issueRender.ts). The top stories above carry real links as
// article cards; making this list clickable is a small EmailServer change,
// noted in docs/R2_BUILD-SPEC.md M5.
function dayByDayBlock(articles: WeeklyArticle[]): Block {
  const sections: string[] = [];
  let currentDate = "";
  for (const article of articles) {
    if (article.date !== currentDate) {
      currentDate = article.date;
      sections.push(`${sections.length > 0 ? "\n" : ""}**${formatDay(article.date)}**`);
    }
    sections.push(`• ${article.title} (${article.source})`);
  }
  return { kind: "text", heading: "📅 Articles by Day", body: sections.join("\n") };
}

// Pure data transform, no API calls - like buildDailyBlocks, so each layout
// path (normal, Weekly Editor failed, empty week) can be checked directly.
// `edited` is null when the Weekly Editor failed: the weekly then still goes
// out (to the operator's review - weeklies never auto-send) with the numbers
// and the full list, just without the cross-week judgment.
export function buildWeeklyBlocks(articles: WeeklyArticle[], edited: WeeklyEditorOutput | null): Block[] {
  if (articles.length === 0) {
    return [
      {
        kind: "text",
        heading: "🔇 Quiet Week in AI News",
        body:
          "We didn't send any AI news articles this week, but that doesn't mean nothing is happening. Use the time to:\n" +
          "• Revisit your product strategy in light of recent weeks' news\n" +
          "• Check how your product compares to competitors' latest launches\n" +
          "• Get ready for next week's announcements",
      },
      {
        kind: "closing_thought",
        heading: "💡 Useful Thought for a Quiet Week",
        body: "Quiet weeks are a good time to talk to five customers - the news can wait, their problems can't.",
      },
    ];
  }

  const blocks: Block[] = [snapshotBlock(computeWeeklyStats(articles))];

  if (edited && edited.topStories.length > 0) {
    blocks.push({
      kind: "text",
      heading: "🎯 Top Stories of the Week",
      body: "The stories that mattered most for product teams this week.",
    });
    for (const story of edited.topStories) {
      blocks.push({
        kind: "article_card",
        emoji: story.emoji,
        title: story.title,
        source: story.source,
        summary: story.summary,
        pmPerspective: story.pmPerspective,
        url: story.url,
      });
    }
  }

  if (edited && edited.themes.length > 0) {
    blocks.push({
      kind: "text",
      heading: "📂 Themes We Saw",
      body: edited.themes
        .map((t) => `**${t.name}** (${t.articleCount} article${t.articleCount === 1 ? "" : "s"}): ${t.description}`)
        .join("\n\n"),
    });
  }

  if (edited && edited.insights.length > 0) {
    blocks.push({
      kind: "text",
      heading: "💡 Key Insights for Product Teams",
      body: edited.insights.map((insight) => `• ${insight}`).join("\n\n"),
    });
  }

  blocks.push(dayByDayBlock(articles));

  blocks.push(
    edited
      ? { kind: "closing_thought", heading: edited.closingThought.heading, body: edited.closingThought.body }
      : {
          kind: "closing_thought",
          heading: "💡 Useful Thought for the Week Ahead",
          body: "Pick the one story above most likely to affect your product, and spend 15 minutes next week on what you'd do if it became the norm.",
        }
  );

  return blocks;
}

// Turns the week's sent dailies (handed over by the Conductor - Content
// Builder never calls EmailServer, architecture doc §15 decision 2) into one
// weekly IssuePayload. Format is "hybrid" (decided 2026-10-14): snapshot,
// top stories, themes, insights, day-by-day list, closing thought.
export async function generateWeeklyIssue(
  config: NewsletterConfig,
  weekContent: IssuePayload[]
): Promise<IssuePayload> {
  const articles = collectWeeklyArticles(weekContent);
  console.log(`[pipeline] Weekly: ${articles.length} article(s) from ${weekContent.length} daily issue(s)`);

  let edited: WeeklyEditorOutput | null = null;
  if (articles.length > 0) {
    const start = Date.now();
    try {
      edited = await runWeeklyEditorAgent(config, articles);
      console.log(
        `[pipeline] Weekly Editor picked ${edited.topStories.length} top stories, ${edited.themes.length} themes, ${edited.insights.length} insights`
      );
    } catch (err) {
      console.error(`[pipeline] Weekly Editor failed, falling back to snapshot + list only: ${(err as Error).message}`);
    } finally {
      console.log(`[pipeline] Weekly Editor took ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }
  }

  return {
    type: "weekly",
    date: todayIsoDate(),
    blocks: buildWeeklyBlocks(articles, edited),
    // Every article here was already checked by the Reviewer in its own
    // daily, and a weekly is always hand-approved (architecture doc §9) -
    // so no second Reviewer pass. Present as [] like every M2+ generation.
    reviewerFlags: [],
  };
}
