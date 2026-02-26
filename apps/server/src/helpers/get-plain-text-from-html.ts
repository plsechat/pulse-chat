function isLegacyHtml(content: string): boolean {
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}

/**
 * Strip HTML tags iteratively until stable to prevent incomplete sanitization
 * when nested/malformed tags produce new tags after a single pass.
 */
function stripTags(html: string): string {
  let result = html;
  let prev: string;
  do {
    prev = result;
    result = result.replace(/<[^>]*>/g, '');
  } while (result !== prev);
  return result;
}

/** Decode common HTML entities to their text equivalents. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Extract plain text from message content.
 * Handles both legacy HTML and token format.
 */
const getPlainTextFromHtml = (content: string): string => {
  if (isLegacyHtml(content)) {
    return decodeEntities(stripTags(content)).trim();
  }

  // Token format: strip tokens and formatting
  return content
    .replace(/<@&?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<:\w+:\d+>/g, '')
    .trim();
};

export { getPlainTextFromHtml };
