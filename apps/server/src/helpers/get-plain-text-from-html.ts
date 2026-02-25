function isLegacyHtml(content: string): boolean {
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}

/**
 * Extract plain text from message content.
 * Handles both legacy HTML and token format.
 */
const getPlainTextFromHtml = (content: string): string => {
  if (isLegacyHtml(content)) {
    return content.replace(/<[^>]+>/g, '').trim();
  }

  // Token format: strip tokens and formatting
  return content
    .replace(/<@&?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<:\w+:\d+>/g, '')
    .trim();
};

export { getPlainTextFromHtml };
