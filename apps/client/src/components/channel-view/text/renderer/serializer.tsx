import { imageExtensions, parseDomCommand } from '@pulse/shared';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import { Element, Text, type DOMNode } from 'html-react-parser';
import { CodeBlockOverride } from '../overrides/code-block';
import { CommandOverride } from '../overrides/command';
import { ChannelMention, MentionOverride } from '../overrides/mention';
import { TwitterOverride } from '../overrides/twitter';
import { YoutubeOverride } from '../overrides/youtube';
import type { TFoundMedia } from './types';

// Build a lookup map for fast emoji name → unicode resolution
const emojiNameMap = new Map<string, string>();
for (const emoji of gitHubEmojis) {
  if (emoji.emoji) {
    emojiNameMap.set(emoji.name, emoji.emoji);
  }
}

function extractText(node: DOMNode): string {
  if (node instanceof Text) return node.data;
  if (node instanceof Element) {
    if (node.name === 'br') return '\n';
    const inner = node.children
      ? node.children.map((child) => extractText(child as DOMNode)).join('')
      : '';
    // Block elements get a trailing newline so consecutive <p>s produce line breaks
    if (node.name === 'p' || node.name === 'div') return inner + '\n';
    return inner;
  }
  return '';
}

const twitterRegex = /https:\/\/(twitter|x).com\/\w+\/status\/(\d+)/g;
const youtubeRegex =
  /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;

const serializer = (
  domNode: DOMNode,
  pushMedia: (media: TFoundMedia) => void
) => {
  // Convert broken emoji img tags (GitHub CDN) to native unicode
  if (domNode instanceof Element && domNode.name === 'img') {
    const isEmojiImg =
      domNode.attribs.class?.includes('emoji-image') ||
      domNode.attribs['data-type'] === 'emoji';

    if (isEmojiImg) {
      const emojiName = domNode.attribs.alt;
      if (emojiName) {
        const unicode = emojiNameMap.get(emojiName);
        if (unicode) {
          return <span className="text-xl leading-none">{unicode}</span>;
        }
      }
    }
  }

  if (domNode instanceof Element && domNode.name === 'a') {
    const href = domNode.attribs.href;

    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      // Invalid or relative URL — skip special handling, render as plain link
    }

    if (url) {
      const isTweet =
        url.hostname.match(/(twitter|x).com/) && href.match(twitterRegex);
      const isYoutube =
        url.hostname.match(/(youtube.com|youtu.be)/) &&
        href.match(youtubeRegex);

      const isImage = imageExtensions.some((ext) => href.endsWith(ext));

      if (isTweet) {
        const tweetId = href.match(twitterRegex)?.[0].split('/').pop();

        if (tweetId) {
          return <TwitterOverride tweetId={tweetId} />;
        }
      } else if (isYoutube) {
        const videoId = href.match(
          /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/
        )?.[7];

        if (videoId) {
          return <YoutubeOverride videoId={videoId} />;
        }
      } else if (isImage) {
        pushMedia({ type: 'image', url: href });

        return <></>;
      }
    }
  } else if (domNode instanceof Element && domNode.name === 'command') {
    const command = parseDomCommand(domNode);

    return <CommandOverride command={command} />;
  } else if (
    domNode instanceof Element &&
    domNode.name === 'span' &&
    domNode.attribs['data-mention-type']
  ) {
    const type = domNode.attribs['data-mention-type'] as 'user' | 'role' | 'all';
    const id = Number(domNode.attribs['data-mention-id']);
    const name =
      domNode.attribs['data-mention-name'] ||
      extractText(domNode as DOMNode).replace(/^@/, '');

    return <MentionOverride type={type} id={id} name={name} />;
  } else if (
    domNode instanceof Element &&
    domNode.name === 'span' &&
    domNode.attribs['data-type'] === 'channel-mention'
  ) {
    const id = Number(domNode.attribs['data-channel-id']);
    const name =
      domNode.attribs['data-channel-name'] ||
      extractText(domNode as DOMNode).replace(/^#/, '');

    return <ChannelMention id={id} name={name} />;
  } else if (domNode instanceof Element && domNode.name === 'pre') {
    const codeChild = domNode.children.find(
      (child) => child instanceof Element && child.name === 'code'
    ) as Element | undefined;

    if (codeChild) {
      const code = extractText(codeChild as DOMNode);
      const langClass = codeChild.attribs?.class ?? '';
      const language = langClass.replace('language-', '') || undefined;

      return <CodeBlockOverride code={code} language={language} />;
    }
  }

  return null;
};

export { serializer };
