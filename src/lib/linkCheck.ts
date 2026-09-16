import { htmlToText } from "./html";

export type LinkCheckResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const MIN_READABLE_TEXT_LENGTH = 200;
const FETCH_TIMEOUT_MS = 10_000;

// Plain fetch + validation - no AI, no retrieval (docs/R2_BUILD-SPEC.md §7.2,
// M2 "link validity"). Also returns the page's text on success, so the
// Reviewer's summary-accuracy check can reuse this same fetch instead of
// hitting the URL twice.
export async function checkArticleLink(url: string): Promise<LinkCheckResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A generic User-Agent reduces (but doesn't eliminate) sites
        // serving a different response to obvious bots than to readers.
        "User-Agent": "Mozilla/5.0 (compatible; ContentBuilderReviewer/1.0)",
      },
    });
  } catch (err) {
    return { ok: false, reason: `Fetch failed: ${(err as Error).message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const finalPath = new URL(response.url).pathname;
  if (finalPath === "" || finalPath === "/") {
    return { ok: false, reason: `Redirected to a homepage (${response.url})` };
  }

  const html = await response.text();
  const text = htmlToText(html);

  if (text.length < MIN_READABLE_TEXT_LENGTH) {
    return { ok: false, reason: "Page returned little to no readable content (possible paywall or bot block)" };
  }

  return { ok: true, text };
}
