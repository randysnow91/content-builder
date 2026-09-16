// Small, hand-rolled HTML-to-text stripper - good enough to give the
// Reviewer agent readable article text, not meant to be a real parser.
// Matches this project's "no new dependency for a shape this small"
// convention (see issue-schema.ts's own header comment).
export function htmlToText(html: string): string {
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withoutTags = withoutNonContent.replace(/<[^>]+>/g, " ");

  return withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
