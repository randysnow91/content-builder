// One-off seeding script for the pm_practices RAG corpus (docs/R2_BUILD-SPEC.md
// M3). Not part of the running server - run by hand, once, with:
//   npx tsx src/scripts/seedPracticeCorpus.ts
// Safe to re-run: it clears existing 'seed' rows first, so re-running after
// editing this file replaces the seed set rather than duplicating it. Rows
// with source: 'feedback' (a future milestone) are left untouched.

import "dotenv/config";
import { embedTexts } from "../lib/embeddings";
import { getSupabaseClient } from "../lib/supabaseClient";

// Approved 2026-09-24 - see docs/R2_BUILD-SPEC.md M3 for how this was
// scoped: judging a short PM Perspective on one AI news article, not general
// product strategy.
const PRACTICES: string[] = [
  // Customer/User Grounding
  "A sound PM Perspective ties a new capability to a specific user or customer problem it could solve, not just to the fact that the technology exists.",
  "Excitement about a technology's cleverness is not the same as evidence that a customer wants it or would pay for it - a good perspective keeps those separate.",
  "When a PM Perspective can't name who benefits and how, that's usually a sign the \"so what\" hasn't actually been thought through yet.",
  "Internal stakeholder enthusiasm (engineering excitement, a competitor's launch) is a reason to pay attention, not a substitute for a real user need.",

  // Distinguishing Signal from Hype
  "A grounded perspective distinguishes between what a company announced and what has actually shipped, been measured, or been validated in the real world.",
  "Claims lifted from a vendor's own marketing language, restated uncritically, are a weaker perspective than one that adds independent judgment.",
  "\"This changes everything\" framing without a specific mechanism for why is a warning sign, not insight - good PM writing names the actual mechanism.",
  "A capability being technically impressive does not by itself mean it is commercially significant; the perspective should address commercial significance directly if it claims it.",

  // Business & Strategic Relevance
  "A useful perspective explains what this news might mean for cost, risk, revenue, adoption, or competitive position - not just that it is interesting.",
  "Naming a plausible business implication (e.g. \"this could lower the cost of X\" or \"this raises switching costs for Y\") is stronger than a purely descriptive summary.",
  "Relevance to product managers specifically means connecting to decisions PMs make - roadmap, prioritization, positioning, build-vs-buy - not just general tech interest.",

  // Risk, Assumptions & Tradeoffs
  "A sound perspective acknowledges the tradeoffs or open questions in a development, rather than presenting only the upside.",
  "Assuming a new technical capability will be adopted, trusted, or embraced by users is itself an assumption that should be flagged as one, not stated as fact.",
  "Cost, risk, and unintended consequences (privacy, trust, dependency on a vendor) deserve at least a mention when a development plausibly raises them.",

  // Actionability for a PM Reader
  "A strong PM Perspective leaves the reader with something concrete to consider for their own product, not just a restatement of the article's summary.",
  "Repeating the article's own framing back without adding independent analysis is a weak perspective, even if factually accurate.",
  "The best perspectives pose a question or implication the reader can carry into their own roadmap or prioritization conversations, rather than simply concluding \"this is worth watching.\"",
];

async function main() {
  console.log(`[seed] Embedding ${PRACTICES.length} practice document(s) via Voyage...`);
  const embeddings = await embedTexts(PRACTICES, "document");

  const supabase = getSupabaseClient();

  console.log("[seed] Clearing existing 'seed' rows...");
  const { error: deleteError } = await supabase.from("pm_practices").delete().eq("source", "seed");
  if (deleteError) {
    throw new Error(`Failed to clear existing seed rows: ${deleteError.message}`);
  }

  const rows = PRACTICES.map((content, i) => ({
    content,
    embedding: embeddings[i],
    source: "seed",
  }));

  console.log(`[seed] Inserting ${rows.length} row(s)...`);
  const { error: insertError } = await supabase.from("pm_practices").insert(rows);
  if (insertError) {
    throw new Error(`Failed to insert seed rows: ${insertError.message}`);
  }

  console.log(`[seed] Done. ${rows.length} practice document(s) seeded.`);
}

main().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
