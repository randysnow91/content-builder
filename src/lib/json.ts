import type Anthropic from "@anthropic-ai/sdk";

// Joins every text block (not just the first - a reply can arrive split
// across several) and parses it with extractJson. Errors carry the
// response's stop_reason, so a reply cut off mid-JSON (Reviewer accuracy
// check, 2026-10-07) shows whether it hit max_tokens, a refusal, or
// something else - the cron log alone couldn't tell us.
export function extractJsonFromResponse<T>(response: Anthropic.Message, agentLabel: string): T {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new Error(`${agentLabel} returned no text content to parse (stop_reason: ${response.stop_reason})`);
  }

  try {
    return extractJson<T>(text);
  } catch (err) {
    throw new Error(`${agentLabel} (stop_reason: ${response.stop_reason}): ${(err as Error).message}`);
  }
}

// Models are told to reply with JSON only, but don't always comply exactly -
// sometimes wrapping it in a ```json fence, sometimes (e.g. explaining why a
// search failed) prepending a sentence or two of prose before the JSON.
// Handle both rather than trusting the instruction to always be followed.
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const jsonText = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(jsonText) as T;
  } catch (firstErr) {
    // Fallback: the model may have prefaced the JSON with an explanation.
    // Take everything from the first [ or { onward and try again.
    const bracketIndex = jsonText.search(/[[{]/);
    if (bracketIndex > 0) {
      try {
        return JSON.parse(jsonText.slice(bracketIndex)) as T;
      } catch {
        // fall through to the error below, which includes the full text
      }
    }

    throw new Error(
      `Expected JSON from the model but couldn't parse it: ${(firstErr as Error).message}\n---\n${text}`
    );
  }
}
