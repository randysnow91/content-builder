import { Router } from "express";
import { generateDailyIssue } from "../pipeline/generateDaily";
import { isValidIssuePayload, type IssuePayload } from "../lib/issue-schema";
import type { NewsletterConfig } from "../agents/types";

// Content-Builder-local diagnostics only - deliberately not part of
// issue-schema.ts (the hand-synced EmailServer contract, docs/
// R2_BUILD-SPEC.md §16.4), so this can name specifics without touching that
// shared file. Named here because this is the exact failure class from the
// missing-URL handoff (2026-10-04): isValidIssuePayload correctly says
// "invalid" but gives no hint which field, forcing a log dig every time.
function describeInvalidIssue(issue: IssuePayload): string {
  const problems: string[] = [];

  if (!issue.rawHtml) {
    if (!Array.isArray(issue.blocks) || issue.blocks.length === 0) {
      problems.push("blocks is empty or missing");
    } else {
      issue.blocks.forEach((block, i) => {
        if (block.kind === "article_card") {
          const required = ["emoji", "title", "source", "summary", "pmPerspective", "url"] as const;
          const missing = required.filter((field) => !isNonEmptyString(block[field]));
          if (missing.length > 0) {
            problems.push(`blocks[${i}] (article_card "${block.title ?? "?"}") missing: ${missing.join(", ")}`);
          }
        } else if (block.kind === "closing_thought" && (!isNonEmptyString(block.heading) || !isNonEmptyString(block.body))) {
          problems.push(`blocks[${i}] (closing_thought) missing heading or body`);
        } else if (block.kind === "text" && !isNonEmptyString(block.body)) {
          problems.push(`blocks[${i}] (text) missing body`);
        }
      });
    }
  }

  (issue.reviewerFlags ?? []).forEach((flag, i) => {
    if (!isNonEmptyString(flag.articleUrl)) problems.push(`reviewerFlags[${i}] has an empty articleUrl`);
    if (!isNonEmptyString(flag.message)) problems.push(`reviewerFlags[${i}] has an empty message`);
  });

  return problems.length > 0 ? problems.join("; ") : "no specific field identified - see the full payload in logs";
}

export const generateRouter = Router();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseNewsletterConfig(value: unknown): NewsletterConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const config = value as Record<string, unknown>;
  if (!isNonEmptyString(config.topics) || !isNonEmptyString(config.voice)) return null;
  return { topics: config.topics, voice: config.voice };
}

generateRouter.post("/generate", async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;

  if (body?.type !== "daily" && body?.type !== "weekly") {
    res.status(400).json({ error: 'body.type must be "daily" or "weekly"' });
    return;
  }

  const newsletterConfig = parseNewsletterConfig(body.newsletterConfig);
  if (!newsletterConfig) {
    res.status(400).json({ error: "body.newsletterConfig must include non-empty topics and voice strings" });
    return;
  }

  if (body.type === "weekly") {
    // Weekly synthesis is M5 (docs/R2_BUILD-SPEC.md) - not built yet.
    res.status(501).json({ error: "Not implemented yet — see docs/R2_BUILD-SPEC.md M5" });
    return;
  }

  try {
    const issue = await generateDailyIssue(newsletterConfig);

    if (!isValidIssuePayload(issue)) {
      const reason = describeInvalidIssue(issue as IssuePayload);
      console.error(`generateDailyIssue produced an invalid IssuePayload (${reason}):`, issue);
      res.status(500).json({ error: `Generation produced an invalid Issue payload: ${reason}` });
      return;
    }

    res.status(200).json(issue);
  } catch (err) {
    console.error("Daily generation failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
