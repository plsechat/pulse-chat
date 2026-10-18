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

/** Decode common HTML entities to their text equivalents (single-pass to prevent double-decoding). */
const entityMap: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&#x2F;': '/'
};
function decodeEntities(text: string): string {
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39|#x27|#x2F);/g, (m) => entityMap[m] ?? m);
}

/**
 * Reduce markdown to the words a reader sees. Forum posts are typed into
 * a plain textarea, so without this the card preview (and the forum
 * search, which filters on it) carries the raw `# ` / `**` / `[t](u)`
 * source. Mirrors apps/client/src/helpers/strip-to-plain-text.ts — keep
 * the two in step.
 *
 * Conservative on purpose: only paired inline markers and line-start
 * block markers go, so snake_case, a lone `*` and `2*3` survive. Code
 * spans and bare URLs are held back first because their contents are
 * literal — a youtube id like `v=_ab_` must not lose its underscores
 * (the same plain text feeds plugin command arguments, e.g. `/watch`).
 */
function stripMarkdown(text: string): string {
  // private-use sentinels: never typed in chat, and not control chars the linter rejects
  const held: string[] = [];
  const hold = (s: string) => {
    held.push(s);
    return `\uE000${held.length - 1}\uE001`;
  };

  let out = text
    // fenced code: single-line ```code``` first, then ```lang\n...\n```; keep the code, drop the lang
    .replace(/```([^`\n]+?)```/g, (_, code: string) => hold(code))
    .replace(/```[^\n]*\n([\s\S]*?)\n?```/g, (_, code: string) => hold(code))
    // an unclosed opener still renders as a block, so its fence line is noise
    .replace(/^```[^\n]*$/gm, '')
    .replace(/(?<!`)`(?!`)([^`\n]+?)`(?!`)/g, (_, code: string) => hold(code))
    // [text](url) and ![alt](url) → the text; before the URL hold so the href is simply dropped
    .replace(/!?\[([^\]\n]*)\]\([^\s)]+(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)]+/g, (m) => hold(m));

  out = out
    // horizontal rules go with their line so they leave no blank gap
    .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$\n?/gm, '')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:>[ \t]+)+/gm, '')
    // bullets, "1." / "1)" and task boxes; digits capped so "2024. A year" is prose, not a list
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    // underscore markers need a word boundary outside so identifiers keep theirs
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1')
    .replace(/(?<!\*)\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)/g, '$1')
    .replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '$1');

  return out.replace(/\uE000(\d+)\uE001/g, (_, i: string) => held[Number(i)] ?? '');
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
  return stripMarkdown(
    content
      .replace(/<@&?\d+>/g, '')
      .replace(/<#\d+>/g, '')
      .replace(/<:\w+:\d+>/g, '')
  ).trim();
};

export { getPlainTextFromHtml };
