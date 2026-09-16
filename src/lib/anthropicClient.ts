import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment automatically. One shared
// client so every agent isn't constructing its own.
//
// timeout/maxRetries are set explicitly rather than trusting the SDK's
// defaults (10 min timeout, 2 retries on timeout) - a long research turn hit
// that combination during M2 testing and took over 10 minutes to fail. A
// shorter timeout with fewer retries fails fast and predictably instead;
// our own pause_turn continuation loop (agentTurn.ts) is what actually
// handles "the model needs another round," not blind SDK-level retries.
export const anthropic = new Anthropic({
  timeout: 3 * 60 * 1000, // 3 minutes per call
  maxRetries: 1,
});
