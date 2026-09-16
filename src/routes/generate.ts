import { Router } from "express";
import { generateDailyIssue } from "../pipeline/generateDaily";
import { isValidIssuePayload } from "../lib/issue-schema";
import type { NewsletterConfig } from "../agents/types";

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
      console.error("generateDailyIssue produced an invalid IssuePayload:", issue);
      res.status(500).json({ error: "Generation produced an invalid Issue payload" });
      return;
    }

    res.status(200).json(issue);
  } catch (err) {
    console.error("Daily generation failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
