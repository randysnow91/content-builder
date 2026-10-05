// Shapes passed between the three agents. Not the wire contract (that's
// issue-schema.ts) - these are Content Builder's own internal working data,
// only ever seen inside this pipeline.

export type NewsletterConfig = {
  topics: string;
  voice: string;
};

export type ArticleCandidate = {
  title: string;
  source: string;
  url: string;
  snippet: string;
};

export type WrittenArticle = {
  emoji: string;
  title: string;
  source: string;
  summary: string;
  pmPerspective: string;
  url: string;
};

export type ClosingThought = {
  heading: string;
  body: string;
};

// An article Curator selected but Writer couldn't produce valid content for
// (missing required field(s), or an index Writer never addressed at all) -
// docs/R2_BUILD-SPEC.md's missing-URL handoff (2026-10-04): drop the one
// article rather than fail the whole Issue, but don't lose it silently -
// generateDaily.ts turns these into a dropped_article reviewer flag.
export type DroppedArticle = {
  url: string;
  title: string;
  reason: string;
};

export type WriterOutput = {
  articles: WrittenArticle[];
  droppedArticles: DroppedArticle[];
  closingThought: ClosingThought;
};
