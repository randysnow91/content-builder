// The Issue/block contract shared with Content Builder and Conductor.
// See docs/CONTENT-PIPELINE-ARCHITECTURE.md §6 (the block model) and §16.4
// (this file is the hand-kept mirror of that contract - copy it into any
// new repo that produces or consumes an Issue, and keep both copies in
// sync by hand until/unless that gets annoying enough to publish as a
// package or serve from an endpoint).
//
// This is the *wire* shape - what Content Builder produces and what
// EmailServer's future ingestion endpoint (§4.2) accepts. Deliberately
// separate from EmailServer's internal Issue database record, which adds
// fields Content Builder never needs to know about (id, status,
// send_after, which newsletter).
//
// No validation library - hand-rolled, matching this project's existing
// style (see isValidEmail in src/lib/validation.ts): a plain type-guard
// function a caller can gate on, no new dependency.

export type ArticleCardBlock = {
  kind: "article_card";
  emoji: string;
  title: string;
  source: string;
  copyright?: string;
  summary: string;
  pmPerspective: string;
  url: string;
};

export type TextBlock = {
  kind: "text";
  heading?: string;
  body: string; // markdown
};

export type ClosingThoughtBlock = {
  kind: "closing_thought";
  heading: string;
  body: string;
};

export type Block = ArticleCardBlock | TextBlock | ClosingThoughtBlock;

export type IssueType = "daily" | "weekly";

export type IssuePayload = {
  type: IssueType;
  date: string; // ISO date, e.g. "2026-09-15"
  blocks: Block[];
  // Escape hatch (§6.3): finished HTML that bypasses block rendering
  // entirely. Rare - only for a deliberate one-off experiment.
  rawHtml?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidBlock(value: unknown): value is Block {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Record<string, unknown>;

  switch (block.kind) {
    case "article_card":
      return (
        isNonEmptyString(block.emoji) &&
        isNonEmptyString(block.title) &&
        isNonEmptyString(block.source) &&
        isNonEmptyString(block.summary) &&
        isNonEmptyString(block.pmPerspective) &&
        isNonEmptyString(block.url)
      );
    case "text":
      return isNonEmptyString(block.body);
    case "closing_thought":
      return isNonEmptyString(block.heading) && isNonEmptyString(block.body);
    default:
      return false;
  }
}

// Gate on this before trusting an incoming Issue - a Content Builder bug
// then produces a clear rejection, never a broken email (§16.4).
export function isValidIssuePayload(value: unknown): value is IssuePayload {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Record<string, unknown>;

  if (issue.type !== "daily" && issue.type !== "weekly") return false;
  if (!isNonEmptyString(issue.date)) return false;
  if (issue.rawHtml !== undefined && typeof issue.rawHtml !== "string") return false;

  // rawHtml alone is a valid payload (§6.3) even with no blocks.
  if (issue.rawHtml) return true;

  return (
    Array.isArray(issue.blocks) &&
    issue.blocks.length > 0 &&
    issue.blocks.every(isValidBlock)
  );
}
