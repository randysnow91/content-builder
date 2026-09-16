// Models are told to reply with JSON only, but sometimes wrap it in a
// ```json fence anyway - strip that before parsing rather than trusting
// the instruction to always be followed.
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const jsonText = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    throw new Error(
      `Expected JSON from the model but couldn't parse it: ${(err as Error).message}\n---\n${text}`
    );
  }
}
