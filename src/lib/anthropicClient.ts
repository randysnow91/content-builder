import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment automatically. One shared
// client so every agent isn't constructing its own.
//
// timeout/maxRetries are set explicitly rather than trusting the SDK's
// defaults (10 min timeout, 2 retries on timeout) - good enough for the
// fast, tool-free calls (Curator, Writer, Reviewer's accuracy check).
// Research overrides both per-call with its own real time budget and an
// AbortSignal tied to it (src/agents/research.ts) - see docs/R2_BUILD-SPEC.md
// M2 for why a single fixed timeout wasn't the right fix for a search that
// can legitimately run anywhere from under a minute to several minutes.
export const anthropic = new Anthropic({
  timeout: 3 * 60 * 1000, // 3 minutes per call
  maxRetries: 1,
});
