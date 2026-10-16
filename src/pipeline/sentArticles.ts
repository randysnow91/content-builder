import type { WeeklyArticle } from "../agents/types";
import type { IssuePayload } from "../lib/issue-schema";

// Shared by the weekly (which is built from the week's sent dailies, M5) and
// the daily (which is shown the last few days' sent dailies so it doesn't
// repeat a story - follow-up from M5, 2026-10-16). Both get those Issues from
// the Conductor; Content Builder never calls EmailServer itself (architecture
// doc §15 decision 2).

// Comparison key for "is this the same link?". Not used to rewrite any URL
// that goes out - only to compare. Ignores the differences that don't change
// which page you land on: http vs https, "www.", case in the host, a trailing
// slash, a #fragment, and tracking parameters (utm_*, fbclid, ...). Other
// query parameters are kept, since some sites use them to pick the article.
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|guccounter)$/i;

export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().toLowerCase();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${path}${query}`;
}

// Pulls every article_card out of a list of sent Issues, in date order.
// Pure, so it can be checked directly against hand-made input. A malformed
// entry is skipped rather than rejecting the whole list, and an article that
// went out twice (same link) is only counted once.
export function collectSentArticles(issues: IssuePayload[]): WeeklyArticle[] {
  const byDate = [...issues]
    .filter((issue) => typeof issue?.date === "string" && Array.isArray(issue.blocks))
    .sort((a, b) => a.date.localeCompare(b.date));

  const seenUrls = new Set<string>();
  const articles: WeeklyArticle[] = [];
  for (const issue of byDate) {
    for (const block of issue.blocks) {
      if (block?.kind !== "article_card" || typeof block.url !== "string" || !block.url) continue;
      const key = normalizeUrl(block.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
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
