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

export type WriterOutput = {
  articles: WrittenArticle[];
  closingThought: ClosingThought;
};
