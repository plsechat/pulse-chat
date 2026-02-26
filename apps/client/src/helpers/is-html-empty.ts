/**
 * Check if HTML content from TipTap is effectively empty.
 * Strips tags and whitespace; returns true for empty editors
 * (e.g. `<p></p>`) while still allowing emoji images and mentions.
 */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  // If there are <img> tags (custom emojis, uploaded files), it's not empty
  if (/<img\s/i.test(html)) return false;
  // Use DOMParser for robust HTML stripping — handles nested tags and entities
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const text = (doc.body.textContent || '').trim();
  return text.length === 0;
}
