/**
 * The pure token-content helpers behind the message renderer: the
 * tokenizer (incl. the `<#msg:chan/id>` and `<#post:chan/thread>` link
 * tokens, bare URLs, nested formatting, code fences, blockquotes),
 * emoji-only detection (channels and DMs share it — the DM body probe
 * asserts the same sizing in both), and legacy-HTML detection.
 *
 * Run via: bun test apps/client/src/lib/converters/__tests__/token-content.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  isEmojiOnlyContent,
  isLegacyHtml,
  tokenize,
  type Token
} from '../token-content';

const text = (value: string): Token => ({ type: 'text', value });
const newline: Token = { type: 'newline' };
const BQ_START = text('\x00BLOCKQUOTE_START\x00');
const BQ_END = text('\x00BLOCKQUOTE_END\x00');

describe('tokenize — mentions and links', () => {
  test('user / role / channel / @everyone', () => {
    expect(tokenize('<@1><@&2><#3>@everyone')).toEqual([
      { type: 'user_mention', id: 1 },
      { type: 'role_mention', id: 2 },
      { type: 'channel_mention', id: 3 },
      { type: 'all_mention' }
    ]);
    expect(tokenize('@everyone hi')).toEqual([{ type: 'all_mention' }, text(' hi')]);
  });

  test('message link token <#msg:channel/message>', () => {
    expect(tokenize('see <#msg:5/77> here')).toEqual([
      text('see '),
      { type: 'message_link', channelId: 5, messageId: 77 },
      text(' here')
    ]);
  });

  test('forum post link token <#post:channel/thread>', () => {
    expect(tokenize('<#post:5/9>')).toEqual([
      { type: 'forum_post_link', channelId: 5, threadId: 9 }
    ]);
  });

  test('a malformed link token is plain text', () => {
    expect(tokenize('<#msg:5>')).toEqual([text('<#msg:5>')]);
    expect(tokenize('<#msg:a/b>')).toEqual([text('<#msg:a/b>')]);
  });

  test('bare URL stops at whitespace and closing brackets', () => {
    expect(tokenize('go https://example.com/a?b=1&c=2 now')).toEqual([
      text('go '),
      { type: 'url', href: 'https://example.com/a?b=1&c=2' },
      text(' now')
    ]);
    expect(tokenize('(https://x.y/p)')).toEqual([
      text('('),
      { type: 'url', href: 'https://x.y/p' },
      text(')')
    ]);
    expect(tokenize('http://plain.example')).toEqual([
      { type: 'url', href: 'http://plain.example' }
    ]);
  });

  test('markdown link wins over the bare URL inside it', () => {
    expect(tokenize('[label](https://x.y) tail')).toEqual([
      { type: 'markdown_link', text: 'label', href: 'https://x.y' },
      text(' tail')
    ]);
  });

  test('custom emoji', () => {
    expect(tokenize('<:party:42>!')).toEqual([
      { type: 'custom_emoji', name: 'party', id: 42 },
      text('!')
    ]);
  });
});

describe('tokenize — formatting', () => {
  test('bold / italic / strike / underline / inline code', () => {
    expect(tokenize('**b**')).toEqual([{ type: 'bold', children: [text('b')] }]);
    expect(tokenize('*i*')).toEqual([{ type: 'italic', children: [text('i')] }]);
    expect(tokenize('~~s~~')).toEqual([{ type: 'strikethrough', children: [text('s')] }]);
    expect(tokenize('__u__')).toEqual([{ type: 'underline', children: [text('u')] }]);
    expect(tokenize('`c`')).toEqual([{ type: 'inline_code', code: 'c' }]);
  });

  test('nested formatting tokenizes the children recursively', () => {
    expect(tokenize('**bold *it* <@1>**')).toEqual([
      {
        type: 'bold',
        children: [
          text('bold '),
          { type: 'italic', children: [text('it')] },
          text(' '),
          { type: 'user_mention', id: 1 }
        ]
      }
    ]);
  });

  test('inline code is literal — tokens inside it are not parsed', () => {
    expect(tokenize('`<@1> **x**`')).toEqual([{ type: 'inline_code', code: '<@1> **x**' }]);
  });

  test('the earliest match wins when markers overlap', () => {
    expect(tokenize('a **b** `c`')).toEqual([
      text('a '),
      { type: 'bold', children: [text('b')] },
      text(' '),
      { type: 'inline_code', code: 'c' }
    ]);
  });

  test('a lone asterisk or underscore is text', () => {
    expect(tokenize('2 * 3')).toEqual([text('2 * 3')]);
    expect(tokenize('snake_case_name')).toEqual([text('snake_case_name')]);
  });
});

describe('tokenize — lines, code blocks, blockquotes', () => {
  test('newlines separate lines without a trailing newline token', () => {
    expect(tokenize('a\nb')).toEqual([text('a'), newline, text('b')]);
    expect(tokenize('a\n\nb')).toEqual([text('a'), newline, newline, text('b')]);
    expect(tokenize('')).toEqual([]);
  });

  test('fenced code block with a language', () => {
    expect(tokenize('```ts\nconst a = 1;\n**raw**\n```')).toEqual([
      { type: 'code_block', lang: 'ts', code: 'const a = 1;\n**raw**' }
    ]);
  });

  test('a code block followed by text gets one newline between them', () => {
    expect(tokenize('```\nx\n```\nafter')).toEqual([
      { type: 'code_block', lang: '', code: 'x' },
      newline,
      text('after')
    ]);
  });

  test('a single-line fence is a code block, not an empty one', () => {
    expect(tokenize('```code```')).toEqual([
      { type: 'code_block', lang: '', code: 'code' }
    ]);
  });

  test('an unclosed opener with nothing after it is shown as text', () => {
    expect(tokenize('```')).toEqual([text('```')]);
    expect(tokenize('```js')).toEqual([text('```js')]);
  });

  test('an unclosed fence with content runs to the end', () => {
    expect(tokenize('```\na\nb')).toEqual([
      { type: 'code_block', lang: '', code: 'a\nb' }
    ]);
  });

  test('blockquote lines are wrapped in the pseudo-markers', () => {
    expect(tokenize('> a\n> **b**\nafter')).toEqual([
      BQ_START,
      text('a\n'),
      { type: 'bold', children: [text('b')] },
      BQ_END,
      newline,
      text('after')
    ]);
  });

  test('">" without the trailing space is plain text', () => {
    expect(tokenize('>not a quote')).toEqual([text('>not a quote')]);
  });
});

describe('isEmojiOnlyContent', () => {
  test('one to six native emoji with no files is emoji-only', () => {
    expect(isEmojiOnlyContent('🎉', 0)).toBe(true);
    expect(isEmojiOnlyContent('🎉🎉', 0)).toBe(true);
    expect(isEmojiOnlyContent('🎉 🎉 🎉', 0)).toBe(true);
    expect(isEmojiOnlyContent('🎉🎉🎉🎉🎉🎉', 0)).toBe(true);
  });

  test('more than six is a normal message', () => {
    expect(isEmojiOnlyContent('🎉🎉🎉🎉🎉🎉🎉', 0)).toBe(false);
  });

  test('custom emoji tokens count as emoji', () => {
    expect(isEmojiOnlyContent('<:party:42>', 0)).toBe(true);
    expect(isEmojiOnlyContent('<:party:42><:x:1>', 0)).toBe(true);
    expect(isEmojiOnlyContent('<:party:42> 🎉', 0)).toBe(true);
  });

  test('variation selectors and ZWJ sequences do not count as text', () => {
    expect(isEmojiOnlyContent('❤️', 0)).toBe(true);
    expect(isEmojiOnlyContent('👨‍👩‍👧', 0)).toBe(true);
  });

  test('any text alongside the emoji disqualifies it', () => {
    expect(isEmojiOnlyContent('🎉 hi', 0)).toBe(false);
    expect(isEmojiOnlyContent('<:party:42> hi', 0)).toBe(false);
    expect(isEmojiOnlyContent('hi', 0)).toBe(false);
    expect(isEmojiOnlyContent('', 0)).toBe(false);
    expect(isEmojiOnlyContent('   ', 0)).toBe(false);
  });

  test('attached files disqualify it (same rule for channel and DM bodies)', () => {
    expect(isEmojiOnlyContent('🎉🎉', 1)).toBe(false);
    expect(isEmojiOnlyContent('<:party:42>', 2)).toBe(false);
  });
});

describe('isLegacyHtml', () => {
  test('editor HTML is recognised', () => {
    expect(isLegacyHtml('<p>hi</p>')).toBe(true);
    expect(isLegacyHtml('<strong>x</strong>')).toBe(true);
    expect(isLegacyHtml('<br>')).toBe(true);
    expect(isLegacyHtml('<pre><code>x</code></pre>')).toBe(true);
  });

  test('token-format content is not', () => {
    expect(isLegacyHtml('')).toBe(false);
    expect(isLegacyHtml('plain')).toBe(false);
    expect(isLegacyHtml('<@1> hi')).toBe(false);
    expect(isLegacyHtml('<@&1>')).toBe(false);
    expect(isLegacyHtml('<#1>')).toBe(false);
    expect(isLegacyHtml('<#msg:1/2>')).toBe(false);
    expect(isLegacyHtml('<:party:42>')).toBe(false);
    expect(isLegacyHtml('1 <2')).toBe(false);
    expect(isLegacyHtml('text then <b>')).toBe(false);
  });
});
