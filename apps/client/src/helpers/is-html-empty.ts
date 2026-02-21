/**
 * Check if HTML content from TipTap is effectively empty.
 * Strips tags and whitespace; returns true for empty editors
 * (e.g. `<p></p>`) while still allowing emoji images and mentions.
 */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  // If there are <img> tags (custom emojis, uploaded files), it's not empty
  if (/<img\s/i.test(html)) return false;
  // Strip all HTML tags, decode &nbsp;, and check if any text remains
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text.length === 0;
}
