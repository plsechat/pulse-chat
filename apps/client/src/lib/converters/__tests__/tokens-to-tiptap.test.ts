/**
 * tokensToTiptapHtml — stored token text back into editor HTML for the
 * inline editor, and the round trip through tiptapHtmlToTokens: what the
 * user saves unchanged must come back byte-identical, or every edit
 * would silently rewrite the message.
 *
 * Run via: bun test apps/client/src/lib/converters/__tests__/tokens-to-tiptap.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { tiptapHtmlToTokens } from '../tiptap-to-tokens';
import { tokensToTiptapHtml, type TokenToTiptapContext } from '../tokens-to-tiptap';

const ctx: TokenToTiptapContext = {
  users: new Map([[1, 'alice']]),
  roles: new Map([[2, 'mods']]),
  channels: new Map([[3, 'general']]),
  emojis: new Map([[42, { name: 'party', src: '/files/42.png' }]])
};

const roundTrip = (tokens: string) => tiptapHtmlToTokens(tokensToTiptapHtml(tokens, ctx));

describe('tokensToTiptapHtml — tokens to node views', () => {
  test('mentions resolve display names from the context', () => {
    expect(tokensToTiptapHtml('hi <@1>', ctx)).toBe(
      '<p>hi <span data-mention-type="user" data-mention-id="1" data-mention-name="alice">@alice</span></p>'
    );
    expect(tokensToTiptapHtml('<@&2>', ctx)).toBe(
      '<p><span data-mention-type="role" data-mention-id="2" data-mention-name="mods">@mods</span></p>'
    );
    expect(tokensToTiptapHtml('<#3>', ctx)).toBe(
      '<p><span data-type="channel-mention" data-channel-id="3" data-channel-name="general">#general</span></p>'
    );
    expect(tokensToTiptapHtml('@everyone', ctx)).toBe(
      '<p><span data-mention-type="all">@all</span></p>'
    );
  });

  test('unknown ids degrade to "Unknown" but keep the id', () => {
    const html = tokensToTiptapHtml('<@999> <@&999> <#999>', ctx);
    expect(html).toContain('data-mention-id="999" data-mention-name="Unknown">@Unknown');
    expect(html).toContain('data-type="channel-mention" data-channel-id="999" data-channel-name="Unknown">#Unknown');
  });

  test('custom emoji becomes the emoji image, with an empty src when unknown', () => {
    expect(tokensToTiptapHtml('<:party:42>', ctx)).toBe(
      '<p><img class="emoji-image" data-emoji-name="party" data-emoji-id="42" src="/files/42.png" alt="party" /></p>'
    );
    expect(tokensToTiptapHtml('<:gone:7>', ctx)).toContain('data-emoji-id="7" src="" alt="gone"');
  });

  test('inline formatting', () => {
    expect(tokensToTiptapHtml('**b** *i* ~~s~~ __u__ `c`', ctx)).toBe(
      '<p><strong>b</strong> <em>i</em> <s>s</s> <u>u</u> <code>c</code></p>'
    );
  });

  test('code blocks keep the language and escape their contents', () => {
    expect(tokensToTiptapHtml('```ts\nconst a = 1 < 2;\n```', ctx)).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>'
    );
    expect(tokensToTiptapHtml('```\nx\n```', ctx)).toBe('<pre><code>x</code></pre>');
  });

  test('an unclosed code block runs to the end of the message', () => {
    expect(tokensToTiptapHtml('```\na\nb', ctx)).toBe('<pre><code>a\nb</code></pre>');
  });

  test('blockquote lines become paragraphs inside one blockquote', () => {
    expect(tokensToTiptapHtml('> a\n> b\nafter', ctx)).toBe(
      '<blockquote><p>a</p><p>b</p></blockquote><p>after</p>'
    );
  });

  test('empty input is an empty paragraph', () => {
    expect(tokensToTiptapHtml('', ctx)).toBe('<p></p>');
  });
});

describe('tokensToTiptapHtml — escaping', () => {
  test('markup in message text is escaped, so it reaches the editor as text', () => {
    expect(tokensToTiptapHtml('<script>alert(1)</script>', ctx)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
    );
    expect(tokensToTiptapHtml('<img src=x onerror=alert(1)>', ctx)).not.toContain('<img');
    expect(tokensToTiptapHtml('a <b>bold?</b> & "q"', ctx)).toBe(
      '<p>a &lt;b&gt;bold?&lt;/b&gt; &amp; &quot;q&quot;</p>'
    );
  });

  test('names from the context are escaped inside attributes and text', () => {
    const hostile: TokenToTiptapContext = {
      ...ctx,
      users: new Map([[1, '"><img src=x onerror=alert(1)>']])
    };
    const html = tokensToTiptapHtml('<@1>', hostile);
    expect(html).not.toContain('<img');
    expect(html).toContain('data-mention-name="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  test('a code-block language is escaped', () => {
    expect(tokensToTiptapHtml('```"><b>\nx\n```', ctx)).toBe(
      '<pre><code class="language-&quot;&gt;&lt;b&gt;">x</code></pre>'
    );
  });

  test('escaped text that looks like a token is still not a token', () => {
    // `&lt;@1&gt;` typed literally by the user is stored as-is; it must
    // not turn into a mention on edit.
    expect(tokensToTiptapHtml('&lt;@1&gt;', ctx)).toBe('<p>&amp;lt;@1&amp;gt;</p>');
  });
});

describe('round trip: tokens → editor HTML → tokens is the identity', () => {
  const fixtures = [
    'hello world',
    'hi <@1>, <@&2> look at <#3> @everyone',
    'unknown <@999> <@&999> <#999> keep their ids',
    'party <:party:42> time <:gone:7>',
    '**bold** *italic* ~~strike~~ __under__ `code`',
    '**bold *and italic* mix**',
    '**bold with <@1> inside**',
    'line one\nline two',
    'a\n\nb',
    '```ts\nconst a = 1;\n```',
    '```\nplain\n```',
    '```\n**not bold** <@1> `tick`\n```',
    '> quoted\n> more',
    '> quoted\nafter',
    '> **b** <@1>',
    'https://example.com/path?x=1',
    '[label](https://example.com)',
    'math: 1 < 2 && 3 > 2',
    'literal <b>tag</b> text',
    'quote " and apostrophe \' and amp &',
    "code block then text\n```js\nx\n```\nafter"
  ];

  for (const fixture of fixtures) {
    test(JSON.stringify(fixture), () => {
      expect(roundTrip(fixture)).toBe(fixture);
    });
  }

  test('a second round trip is stable too', () => {
    for (const fixture of fixtures) {
      expect(roundTrip(roundTrip(fixture))).toBe(fixture);
    }
  });
});
