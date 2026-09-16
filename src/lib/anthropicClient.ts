import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment automatically. One shared
// client so every agent isn't constructing its own.
export const anthropic = new Anthropic();
