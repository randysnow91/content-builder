import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropicClient";

type RequestOptions = Anthropic.RequestOptions;

// A turn with heavy tool use (many web searches) can end early with
// stop_reason "pause_turn" instead of finishing - the API's way of saying
// "I'm not done, send this back to continue." This loops until a real
// terminal stop_reason (end_turn, max_tokens, etc.), so callers always get
// Claude's actual final answer.
//
// requestOptions lets a caller override the client's default timeout/retry
// behavior per call - real web-search turns can legitimately run well past
// a few minutes, which is too long a wait to retry blindly (see research.ts).
export async function runUntilDone(
  params: Anthropic.MessageCreateParamsNonStreaming,
  requestOptions?: RequestOptions,
  maxContinuations = 5
): Promise<Anthropic.Message> {
  let messages = params.messages;
  let response = await anthropic.messages.create({ ...params, messages }, requestOptions);

  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < maxContinuations) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await anthropic.messages.create({ ...params, messages }, requestOptions);
    continuations++;
  }

  return response;
}
