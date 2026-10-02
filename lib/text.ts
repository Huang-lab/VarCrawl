/** Decodes the HTML/XML entities that NCBI and Europe PMC leave in titles. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Decodes entities and strips inline markup tags (e.g. &lt;i&gt;BRCA1&lt;/i&gt;) from upstream titles. */
export function cleanTitle(s: string): string {
  return decodeEntities(s).replace(/<\/?(?:i|b|u|em|strong|sub|sup|italic|bold)\b[^>]*>/gi, "");
}
