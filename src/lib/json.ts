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
