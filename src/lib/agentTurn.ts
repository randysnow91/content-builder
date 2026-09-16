import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropicClient";

// A turn with heavy tool use (many web searches) can end early with
// stop_reason "pause_turn" instead of finishing - the API's way of saying
// "I'm not done, send this back to continue." This loops until a real
// terminal stop_reason (end_turn, max_tokens, etc.), so callers always get
// Claude's actual final answer.
export async function runUntilDone(
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxContinuations = 5
): Promise<Anthropic.Message> {
  let messages = params.messages;
  let response = await anthropic.messages.create({ ...params, messages });

  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < maxContinuations) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await anthropic.messages.create({ ...params, messages });
    continuations++;
  }

  return response;
}
