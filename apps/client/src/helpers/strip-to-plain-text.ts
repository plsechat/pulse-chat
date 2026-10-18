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
 * Reduce markdown to the words a reader sees — previews, notifications
 * and search would otherwise show the raw `# ` / `**` / `[t](u)` source
 * users type into the forum textarea. Mirrors the server's
 * helpers/get-plain-text-from-html.ts — keep the two in step.
 *
 * Conservative on purpose: only paired inline markers and line-start
 * block markers go, so snake_case, a lone `*` and `2*3` survive. Code
 * spans and bare URLs are held back first because their contents are
 * literal (a youtube id like `v=_ab_` must keep its underscores).
 */
const stripMarkdown = (text: string): string => {
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
};

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
  return stripMarkdown(
    content
      .replace(/<@\d+>/g, '@user')
      .replace(/<@&\d+>/g, '@role')
      .replace(/<#\d+>/g, '#channel')
      .replace(/<:(\w+):\d+>/g, ':$1:')
  ).trim();
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
