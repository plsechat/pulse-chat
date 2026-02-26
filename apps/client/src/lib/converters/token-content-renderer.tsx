/**
 * Renders plain text with token syntax into React elements.
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
import { imageExtensions } from '@pulse/shared';
import type { ReactNode } from 'react';
import { Fragment, memo, useMemo } from 'react';
import { CodeBlockOverride } from '@/components/channel-view/text/overrides/code-block';
import {
  ChannelMention,
  MentionOverride
} from '@/components/channel-view/text/overrides/mention';
import { TwitterOverride } from '@/components/channel-view/text/overrides/twitter';
import { YoutubeOverride } from '@/components/channel-view/text/overrides/youtube';
import { CustomEmoji } from './custom-emoji';
import type { TFoundMedia } from '@/components/channel-view/text/renderer/types';

// ── Token types ──────────────────────────────────────────────

type Token =
  | { type: 'text'; value: string }
  | { type: 'user_mention'; id: number }
  | { type: 'role_mention'; id: number }
  | { type: 'all_mention' }
  | { type: 'channel_mention'; id: number }
  | { type: 'custom_emoji'; name: string; id: number }
  | { type: 'code_block'; lang: string; code: string }
  | { type: 'inline_code'; code: string }
  | { type: 'bold'; children: Token[] }
  | { type: 'italic'; children: Token[] }
  | { type: 'strikethrough'; children: Token[] }
  | { type: 'underline'; children: Token[] }
  | { type: 'url'; href: string }
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
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing ```
      if (i < lines.length) i++;
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

// ── Renderer ─────────────────────────────────────────────────

const twitterRegex = /https:\/\/(twitter|x)\.com\/\w+\/status\/(\d+)/;
const youtubeRegex =
  /^.*((youtu\.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;

function renderTokens(
  tokens: Token[],
  pushMedia: (media: TFoundMedia) => void
): ReactNode[] {
  const elements: ReactNode[] = [];
  let blockquoteContent: Token[] | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Handle blockquote markers
    if (
      token.type === 'text' &&
      token.value === '\x00BLOCKQUOTE_START\x00'
    ) {
      blockquoteContent = [];
      continue;
    }
    if (
      token.type === 'text' &&
      token.value === '\x00BLOCKQUOTE_END\x00'
    ) {
      if (blockquoteContent) {
        elements.push(
          <blockquote key={`bq-${i}`}>
            <p>{renderTokens(blockquoteContent, pushMedia)}</p>
          </blockquote>
        );
        blockquoteContent = null;
      }
      continue;
    }
    if (blockquoteContent) {
      blockquoteContent.push(token);
      continue;
    }

    switch (token.type) {
      case 'text':
        elements.push(<Fragment key={`t-${i}`}>{token.value}</Fragment>);
        break;

      case 'newline':
        elements.push(<br key={`br-${i}`} />);
        break;

      case 'user_mention':
        elements.push(
          <MentionOverride
            key={`um-${i}`}
            type="user"
            id={token.id}
            name=""
          />
        );
        break;

      case 'role_mention':
        elements.push(
          <MentionOverride
            key={`rm-${i}`}
            type="role"
            id={token.id}
            name=""
          />
        );
        break;

      case 'all_mention':
        elements.push(
          <MentionOverride key={`am-${i}`} type="all" id={0} name="all" />
        );
        break;

      case 'channel_mention':
        elements.push(
          <ChannelMention key={`cm-${i}`} id={token.id} name="" />
        );
        break;

      case 'custom_emoji':
        elements.push(
          <CustomEmoji key={`ce-${i}`} name={token.name} id={token.id} />
        );
        break;

      case 'code_block':
        elements.push(
          <CodeBlockOverride
            key={`cb-${i}`}
            code={token.code}
            language={token.lang || undefined}
          />
        );
        break;

      case 'inline_code':
        elements.push(<code key={`ic-${i}`}>{token.code}</code>);
        break;

      case 'bold':
        elements.push(
          <strong key={`b-${i}`}>
            {renderTokens(token.children, pushMedia)}
          </strong>
        );
        break;

      case 'italic':
        elements.push(
          <em key={`i-${i}`}>
            {renderTokens(token.children, pushMedia)}
          </em>
        );
        break;

      case 'strikethrough':
        elements.push(
          <s key={`s-${i}`}>
            {renderTokens(token.children, pushMedia)}
          </s>
        );
        break;

      case 'underline':
        elements.push(
          <u key={`u-${i}`}>
            {renderTokens(token.children, pushMedia)}
          </u>
        );
        break;

      case 'url': {
        const href = token.href;

        // Twitter/X embed
        const tweetMatch = href.match(twitterRegex);
        if (tweetMatch) {
          const tweetId = href.split('/').pop();
          if (tweetId) {
            elements.push(
              <TwitterOverride key={`tw-${i}`} tweetId={tweetId} />
            );
            break;
          }
        }

        // YouTube embed
        const ytMatch = href.match(youtubeRegex);
        if (ytMatch) {
          const videoId = ytMatch[7];
          if (videoId) {
            elements.push(
              <YoutubeOverride key={`yt-${i}`} videoId={videoId} />
            );
            break;
          }
        }

        // Image URL → push as media
        if (imageExtensions.some((ext) => href.endsWith(ext))) {
          pushMedia({ type: 'image', url: href });
          break;
        }

        // Regular link
        elements.push(
          <a
            key={`a-${i}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {href}
          </a>
        );
        break;
      }
    }
  }

  return elements;
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

// ── Public API ───────────────────────────────────────────────

type TokenContentRendererProps = {
  content: string;
  fileCount: number;
  onFoundMedia: (media: TFoundMedia) => void;
};

const TokenContentRenderer = memo(
  ({ content, fileCount, onFoundMedia }: TokenContentRendererProps) => {
    const { elements, isEmojiOnly } = useMemo(() => {
      const foundMedia: TFoundMedia[] = [];
      const tokens = tokenize(content);
      const pushMedia = (media: TFoundMedia) => foundMedia.push(media);
      const elements = renderTokens(tokens, pushMedia);
      const isEmojiOnly = isEmojiOnlyContent(content, fileCount);

      // Push found media to parent after render
      for (const m of foundMedia) onFoundMedia(m);

      return { elements, isEmojiOnly };
    }, [content, fileCount, onFoundMedia]);

    return (
      <span className={isEmojiOnly ? 'emoji-only' : undefined}>
        {elements}
      </span>
    );
  }
);

export { TokenContentRenderer, isEmojiOnlyContent, tokenize, renderTokens };

/** Detect whether content is in legacy HTML format vs token format. */
export function isLegacyHtml(content: string): boolean {
  if (!content) return false;
  // HTML content from Tiptap always starts with <p> or contains HTML tags
  return content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);
}
