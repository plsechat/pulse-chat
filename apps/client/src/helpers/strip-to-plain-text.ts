import { isLegacyHtml } from '@/lib/converters/token-content';

/**
 * The entities the editor's HTML serializer emits for text. Legacy
 * messages store them literally, so a preview of "Tom & Jerry" would
 * otherwise read "Tom &amp; Jerry". `&amp;` goes last so an escaped
 * entity (`&amp;lt;`) decodes exactly one level.
 */
const decodeEntities = (text: string): string =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Extract readable plain text from message content.
 * Handles both legacy HTML format and token format.
 * Used for reply previews, notifications, sidebar previews, copy text, etc.
 */
export function stripToPlainText(content: string | null | undefined): string {
  if (!content) return '';

  if (isLegacyHtml(content)) {
    // Iteratively strip HTML tags until stable (handles nested/malformed tags)
    let result = content;
    let prev: string;
    do { prev = result; result = result.replace(/<[^>]*>/g, ''); } while (result !== prev);
    return decodeEntities(result).trim();
  }

  // Token format → resolve tokens to readable text
  return content
    .replace(/<@\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<:(\w+):\d+>/g, ':$1:')
    .replace(/[*~_`]/g, '')
    .trim();
}

/**
 * Check if token-format content is effectively empty.
 */
export function isTokenContentEmpty(text: string): boolean {
  if (!text) return true;
  // Custom emoji tokens count as non-empty
  if (/<:\w+:\d+>/.test(text)) return false;
  // Mentions count as non-empty
  if (/<@&?\d+>/.test(text)) return false;
  if (/<#\d+>/.test(text)) return false;
  if (/@everyone/.test(text)) return false;

  const stripped = text
    .replace(/[*~_`>\n]/g, '')
    .trim();
  return stripped.length === 0;
}
