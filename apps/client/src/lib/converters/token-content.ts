/**
 * Pure token-content helpers (no React). The tokenizer, emoji-only
 * detection and legacy-HTML detection live here so the renderer file
 * only exports components (fast-refresh friendly) and so non-React
 * callers (strip-to-plain-text, reply previews) don't pull the JSX
 * renderer in.
 *
 * Token format:
 *   <@123>        → user mention
 *   <@&456>       → role mention
 *   @everyone     → @all mention
 *   <#789>        → channel mention
 *   <:name:42>    → custom emoji
 *   **bold**      → bold
 *   *italic*      → italic
 *   ~~strike~~    → strikethrough
 *   `code`        → inline code
 *   ```lang\n...\n``` → code block
 *   > text        → blockquote
 *   https://...   → auto-linked URL
 *   \n            → line break
 */

// ── Token types ──────────────────────────────────────────────

export type Token =
  | { type: 'text'; value: string }
  | { type: 'user_mention'; id: number }
  | { type: 'role_mention'; id: number }
  | { type: 'all_mention' }
  | { type: 'channel_mention'; id: number }
  | { type: 'forum_post_link'; channelId: number; threadId: number }
  | { type: 'message_link'; channelId: number; messageId: number }
  | { type: 'custom_emoji'; name: string; id: number }
  | { type: 'code_block'; lang: string; code: string }
  | { type: 'inline_code'; code: string }
  | { type: 'bold'; children: Token[] }
  | { type: 'italic'; children: Token[] }
  | { type: 'strikethrough'; children: Token[] }
  | { type: 'underline'; children: Token[] }
  | { type: 'url'; href: string }
  | { type: 'markdown_link'; href: string; text: string }
  | { type: 'newline' };

// ── Tokenizer ────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>)]+/;

/** Tokenize inline content (no code blocks, no blockquotes). */
function tokenizeInline(text: string): Token[] {
  const tokens: Token[] = [];
  let remaining = text;

  type Match = { index: number; length: number; token: Token };

  const tryMatch = (
    remaining: string,
    re: RegExp,
    toToken: (m: RegExpMatchArray) => Token | null,
    best: Match | null
  ): Match | null => {
    const m = remaining.match(re);
    if (m && m.index !== undefined) {
      const tok = toToken(m);
      if (tok && (!best || m.index < best.index)) {
        return { index: m.index, length: m[0].length, token: tok };
      }
    }
    return best;
  };

  while (remaining.length > 0) {
    let best: Match | null = null;

    // User mention: <@123>
    best = tryMatch(remaining, /<@(\d+)>/, (m) => ({
      type: 'user_mention', id: Number(m[1])
    }), best);

    // Role mention: <@&123>
    best = tryMatch(remaining, /<@&(\d+)>/, (m) => ({
      type: 'role_mention', id: Number(m[1])
    }), best);

    // @everyone
    best = tryMatch(remaining, /@everyone/, () => ({
      type: 'all_mention'
    }), best);

    // Forum post link: <#post:channelId/threadId>
    best = tryMatch(
      remaining,
      /<#post:(\d+)\/(\d+)>/,
      (m) => ({
        type: 'forum_post_link',
        channelId: Number(m[1]),
        threadId: Number(m[2])
      }),
      best
    );

    // Message link: <#msg:channelId/messageId>
    best = tryMatch(
      remaining,
      /<#msg:(\d+)\/(\d+)>/,
      (m) => ({
        type: 'message_link',
        channelId: Number(m[1]),
        messageId: Number(m[2])
      }),
      best
    );

    // Channel mention: <#123>
    best = tryMatch(remaining, /<#(\d+)>/, (m) => ({
      type: 'channel_mention', id: Number(m[1])
    }), best);

    // Custom emoji: <:name:123>
    best = tryMatch(remaining, /<:(\w+):(\d+)>/, (m) => ({
      type: 'custom_emoji', name: m[1], id: Number(m[2])
    }), best);

    // Inline code: `code` (but not ```)
    best = tryMatch(remaining, /(?<!`)`(?!`)([^`\n]+?)`(?!`)/, (m) => ({
      type: 'inline_code', code: m[1]
    }), best);

    // Bold: **text**
    best = tryMatch(remaining, /\*\*(.+?)\*\*/, (m) => ({
      type: 'bold', children: tokenizeInline(m[1])
    }), best);

    // Italic: *text* (not preceded/followed by another *)
    best = tryMatch(remaining, /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/, (m) => ({
      type: 'italic', children: tokenizeInline(m[1])
    }), best);

    // Strikethrough: ~~text~~
    best = tryMatch(remaining, /~~(.+?)~~/, (m) => ({
      type: 'strikethrough', children: tokenizeInline(m[1])
    }), best);

    // Underline: __text__
    best = tryMatch(remaining, /__(.+?)__/, (m) => ({
      type: 'underline', children: tokenizeInline(m[1])
    }), best);

    // Markdown link: [text](https://url) — must run before bare URL_RE so
    // we don't render the URL twice (once as the link, once as text inside
    // the brackets). tryMatch picks the earliest-starting match; the `[`
    // sits before the embedded URL so this wins for well-formed syntax.
    best = tryMatch(
      remaining,
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
      (m) => ({ type: 'markdown_link', text: m[1], href: m[2] }),
      best
    );

    // URL
    best = tryMatch(remaining, URL_RE, (m) => ({
      type: 'url', href: m[0]
    }), best);

    if (best) {
      if (best.index > 0) {
        tokens.push({ type: 'text', value: remaining.slice(0, best.index) });
      }
      tokens.push(best.token);
      remaining = remaining.slice(best.index + best.length);
    } else {
      tokens.push({ type: 'text', value: remaining });
      remaining = '';
    }
  }

  return tokens;
}

/** Tokenize a full message (handles code blocks and blockquotes first). */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```lang ... ```
    if (line.startsWith('```')) {
      const inner = line.slice(3);

      // Single-line fence (```code```): the composer never produces it,
      // but federated peers / API clients can — the multi-line path
      // below would misread it as an opener + garbage lang and render
      // an EMPTY block (invisible message).
      if (inner.endsWith('```') && inner.length > 3) {
        tokens.push({
          type: 'code_block',
          lang: '',
          code: inner.slice(0, -3)
        });
        i++;
        if (i < lines.length) tokens.push({ type: 'newline' });
        continue;
      }

      const lang = inner.trim();
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('```')) {
        codeLines.push(lines[j]);
        j++;
      }
      const closed = j < lines.length;

      // Unclosed opener with nothing after it — show the raw line as
      // text instead of an invisible empty block.
      if (!closed && codeLines.length === 0) {
        tokens.push(...tokenizeInline(line));
        i++;
        if (i < lines.length) tokens.push({ type: 'newline' });
        continue;
      }

      // Skip closing ``` when present
      i = closed ? j + 1 : j;
      tokens.push({ type: 'code_block', lang, code: codeLines.join('\n') });
      // Add newline after code block unless it's the last thing
      if (i < lines.length) tokens.push({ type: 'newline' });
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [line.slice(2)];
      i++;
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const innerText = quoteLines.join('\n');
      const innerTokens = tokenizeInline(innerText);
      // Wrap in a "blockquote" pseudo-token — we'll handle it at render time
      tokens.push({
        type: 'text',
        value: `\x00BLOCKQUOTE_START\x00`
      });
      tokens.push(...innerTokens);
      tokens.push({
        type: 'text',
        value: `\x00BLOCKQUOTE_END\x00`
      });
      if (i < lines.length) tokens.push({ type: 'newline' });
      continue;
    }

    // Regular line — tokenize inline content
    if (line.length > 0) {
      tokens.push(...tokenizeInline(line));
    }
    i++;
    // Add newline between lines (not after last)
    if (i < lines.length) {
      tokens.push({ type: 'newline' });
    }
  }

  return tokens;
}

// ── Emoji-only detection ─────────────────────────────────────

const nativeEmojiRe = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

function isEmojiOnlyContent(text: string, fileCount: number): boolean {
  if (fileCount > 0) return false;

  // Strip token syntax for custom emojis, count them
  const customEmojiMatches = text.match(/<:\w+:\d+>/g);
  const withoutCustom = text.replace(/<:\w+:\d+>/g, '');

  // Strip native emojis, count them
  const nativeEmojiMatches = withoutCustom.match(nativeEmojiRe);
  const withoutAll = withoutCustom
    .replace(nativeEmojiRe, '')
    .replace(/\u200D|\uFE0E|\uFE0F/g, '')
    .trim();

  const totalEmojis =
    (customEmojiMatches?.length ?? 0) + (nativeEmojiMatches?.length ?? 0);

  return withoutAll.length === 0 && totalEmojis >= 1 && totalEmojis <= 6;
}

/** Detect whether content is in legacy HTML format vs token format. */
function isLegacyHtml(content: string): boolean {
  if (!content) return false;
  // HTML content from Tiptap always starts with <p> or contains HTML tags
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}

export { tokenize, isEmojiOnlyContent, isLegacyHtml };
