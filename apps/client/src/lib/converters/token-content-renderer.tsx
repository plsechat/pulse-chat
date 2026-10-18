/**
 * Renders token-format message content into React elements. The
 * tokenizer and the pure content predicates live in token-content.ts.
 */
import { imageExtensions } from '@pulse/shared';
import type { ReactNode } from 'react';
import { Fragment, memo, useMemo } from 'react';
import { CodeBlockOverride } from '@/components/chat-primitives/overrides/code-block';
import {
  ChannelMention,
  ForumPostLink,
  MentionOverride,
  MessageLink
} from '@/components/chat-primitives/overrides/mention';
import { TwitterOverride } from '@/components/chat-primitives/overrides/twitter';
import { YoutubeOverride } from '@/components/chat-primitives/overrides/youtube';
import {
  getTweetId,
  getYoutubeVideoId
} from '@/components/chat-primitives/embed-matchers';
import { CustomEmoji } from './custom-emoji';
import { isEmojiOnlyContent, tokenize, type Token } from './token-content';
import type { TFoundMedia } from '@/components/chat-primitives/types';

// ── Renderer ─────────────────────────────────────────────────

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

      case 'forum_post_link':
        elements.push(
          <ForumPostLink
            key={`fpl-${i}`}
            channelId={token.channelId}
            threadId={token.threadId}
          />
        );
        break;

      case 'message_link':
        elements.push(
          <MessageLink
            key={`ml-${i}`}
            channelId={token.channelId}
            messageId={token.messageId}
          />
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

      case 'markdown_link':
        elements.push(
          <a
            key={`ml-${i}`}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {token.text}
          </a>
        );
        break;

      case 'url': {
        const href = token.href;

        // Twitter/X embed
        const tweetId = getTweetId(href);
        if (tweetId) {
          elements.push(
            <TwitterOverride key={`tw-${i}`} tweetId={tweetId} />
          );
          break;
        }

        // YouTube embed — host-checked, so a share link from another
        // service whose path happens to fit the id pattern stays a link.
        const videoId = getYoutubeVideoId(href);
        if (videoId) {
          elements.push(
            <YoutubeOverride key={`yt-${i}`} videoId={videoId} />
          );
          break;
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

export { TokenContentRenderer };
