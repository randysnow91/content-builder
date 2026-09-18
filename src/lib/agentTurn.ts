import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropicClient";

type RequestOptions = Anthropic.RequestOptions;

function elapsedSeconds(start: number): string {
  return ((Date.now() - start) / 1000).toFixed(1);
}

// Runs one turn as a stream instead of a single blocking call, logging
// progress as it goes. This isn't just for visibility - a non-streaming
// call that takes a long time (a heavy web-search turn) can hit a network-
// level idle timeout underneath the SDK's own `timeout` option, independent
// of what we tell the SDK. Anthropic's own SDK source says as much:
// "Streaming is required for operations that may take longer than 10
// minutes." Streaming keeps the connection actively receiving data instead
// of sitting idle waiting for one giant response, which sidesteps that.
//
// Earlier version of this tried to abort mid-stream once a tool-use cap was
// hit and force a final answer from partial results. Dropped 2026-09-18:
// the API rejects a follow-up turn with "When responding to programmatic
// tool calling, only tool_result blocks are allowed" whenever the abort
// lands while a server tool call is still in flight, which is hard to
// avoid reliably (events can arrive faster than we can react). "Always
// return something" is instead handled one layer up, in generateDaily.ts -
// if this whole call fails for any reason (this cap included, or the
// timeout below), the pipeline falls back to the same "no articles found"
// path already built for a genuinely empty search result, rather than a
// raw error.
async function runOneStreamedTurn(
  params: Anthropic.MessageStreamParams,
  requestOptions?: RequestOptions
): Promise<Anthropic.Message> {
  const start = Date.now();
  const stream = anthropic.messages.stream(params, requestOptions);
  let toolUseCount = 0;

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
      toolUseCount++;
      console.log(`[agentTurn] tool use #${toolUseCount} started (+${elapsedSeconds(start)}s)`);
    }
    if (event.type === "content_block_start" && event.content_block.type === "web_search_tool_result") {
      const content = event.content_block.content;
      if (!Array.isArray(content)) {
        console.log(`[agentTurn] web_search_tool_result ERROR: ${content.error_code} (+${elapsedSeconds(start)}s)`);
      } else {
        console.log(`[agentTurn] web_search_tool_result: ${content.length} result(s) (+${elapsedSeconds(start)}s)`);
      }
    }
  }

  const message = await stream.finalMessage();
  console.log(
    `[agentTurn] turn finished: stop_reason=${message.stop_reason}, ${toolUseCount} tool use(s), took ${elapsedSeconds(start)}s`
  );
  return message;
}

// A turn with heavy tool use (many web searches) can end early with
// stop_reason "pause_turn" instead of finishing - the API's way of saying
// "I'm not done, send this back to continue." This loops until a real
// terminal stop_reason (end_turn, max_tokens, etc.), so callers always get
// Claude's actual final answer.
//
// requestOptions lets a caller override the client's default timeout/retry
// behavior per call - real web-search turns can legitimately run well past
// a few minutes, which is too long a wait to retry blindly (see research.ts,
// which sets a generous per-call timeout with no retries as the real
// backstop against a turn that never converges).
export async function runUntilDone(
  params: Anthropic.MessageCreateParamsNonStreaming,
  requestOptions?: RequestOptions,
  maxContinuations = 5
): Promise<Anthropic.Message> {
  let messages = params.messages;
  let response = await runOneStreamedTurn({ ...params, messages }, requestOptions);

  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < maxContinuations) {
    console.log(`[agentTurn] pause_turn - continuing (${continuations + 1}/${maxContinuations})`);
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await runOneStreamedTurn({ ...params, messages }, requestOptions);
    continuations++;
  }

  return response;
}
