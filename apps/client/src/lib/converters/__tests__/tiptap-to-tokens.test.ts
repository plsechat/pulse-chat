/**
 * tiptapHtmlToTokens — the composer's HTML (mention/emoji/channel node
 * views, StarterKit marks, code blocks, blockquotes, paragraphs) to the
 * token format the server stores. Fixtures mirror what the editor's
 * `getHTML()` emits for each node type.
 *
 * Run via: bun test apps/client/src/lib/converters/__tests__/tiptap-to-tokens.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { tiptapHtmlToTokens } from '../tiptap-to-tokens';

const userMention = (id: number, name: string) =>
  `<span class="mention" data-mention-type="user" data-mention-id="${id}" data-mention-name="${name}">@${name}</span>`;
const roleMention = (id: number, name: string) =>
  `<span class="mention" data-mention-type="role" data-mention-id="${id}" data-mention-name="${name}">@${name}</span>`;
const allMention = () =>
  '<span class="mention" data-mention-type="all" data-mention-name="all">@all</span>';
const channelMention = (id: number, name: string) =>
  `<span class="mention" data-type="channel-mention" data-channel-id="${id}" data-channel-name="${name}">#${name}</span>`;
const customEmoji = (id: number, name: string) =>
  `<img class="emoji-image" data-emoji-id="${id}" data-emoji-name="${name}" src="/files/${id}.png" alt="${name}">`;

describe('tiptapHtmlToTokens — mentions', () => {
  test('user, role, channel and @all node views become tokens', () => {
    expect(tiptapHtmlToTokens(`<p>hi ${userMention(7, 'bob')}</p>`)).toBe('hi <@7>');
    expect(tiptapHtmlToTokens(`<p>${roleMention(3, 'mods')} wake</p>`)).toBe('<@&3> wake');
    expect(tiptapHtmlToTokens(`<p>${allMention()} meeting</p>`)).toBe('@everyone meeting');
    expect(tiptapHtmlToTokens(`<p>see ${channelMention(9, 'general')}</p>`)).toBe('see <#9>');
  });

  test('a mention span without an id degrades to its visible text', () => {
    expect(
      tiptapHtmlToTokens('<p><span data-mention-type="user" data-mention-name="x">@x</span></p>')
    ).toBe('@x');
    expect(
      tiptapHtmlToTokens('<p><span data-type="channel-mention">#gone</span></p>')
    ).toBe('#gone');
  });
});

describe('tiptapHtmlToTokens — emoji images', () => {
  test('custom server emoji with an id becomes <:name:id>', () => {
    expect(tiptapHtmlToTokens(`<p>party ${customEmoji(42, 'party')}</p>`)).toBe(
      'party <:party:42>'
    );
  });

  test('custom emoji falls back to alt for the name', () => {
    expect(
      tiptapHtmlToTokens('<p><img class="emoji-image" data-emoji-id="5" alt="wave"></p>')
    ).toBe('<:wave:5>');
  });

  test('a standard emoji rendered as an image emits its alt text', () => {
    expect(tiptapHtmlToTokens('<p><img class="emoji-image" alt="🎉"></p>')).toBe('🎉');
    expect(tiptapHtmlToTokens('<p><img data-type="emoji" alt="😀"></p>')).toBe('😀');
  });

  test('any other image is dropped', () => {
    expect(tiptapHtmlToTokens('<p>a<img src="/x.png" alt="x">b</p>')).toBe('ab');
  });
});

describe('tiptapHtmlToTokens — marks', () => {
  test('bold / italic / strike / underline / inline code', () => {
    expect(tiptapHtmlToTokens('<p><strong>b</strong></p>')).toBe('**b**');
    expect(tiptapHtmlToTokens('<p><b>b</b></p>')).toBe('**b**');
    expect(tiptapHtmlToTokens('<p><em>i</em></p>')).toBe('*i*');
    expect(tiptapHtmlToTokens('<p><i>i</i></p>')).toBe('*i*');
    expect(tiptapHtmlToTokens('<p><s>s</s></p>')).toBe('~~s~~');
    expect(tiptapHtmlToTokens('<p><del>s</del></p>')).toBe('~~s~~');
    expect(tiptapHtmlToTokens('<p><u>u</u></p>')).toBe('__u__');
    expect(tiptapHtmlToTokens('<p><code>c</code></p>')).toBe('`c`');
  });

  test('nested marks nest their markers', () => {
    expect(
      tiptapHtmlToTokens('<p><strong>bold <em>and italic</em> mix</strong></p>')
    ).toBe('**bold *and italic* mix**');
  });

  test('marks around a mention keep the mention token', () => {
    expect(tiptapHtmlToTokens(`<p><strong>ping ${userMention(1, 'a')}</strong></p>`)).toBe(
      '**ping <@1>**'
    );
  });
});

describe('tiptapHtmlToTokens — code blocks', () => {
  test('pre > code.language-x becomes a fenced block with the language', () => {
    expect(
      tiptapHtmlToTokens('<pre><code class="language-ts">const a = 1;</code></pre>')
    ).toBe('```ts\nconst a = 1;\n```');
  });

  test('a code block without a language class opens a bare fence', () => {
    expect(tiptapHtmlToTokens('<pre><code>plain</code></pre>')).toBe('```\nplain\n```');
    expect(tiptapHtmlToTokens('<pre>no code child</pre>')).toBe('```\nno code child\n```');
  });

  test('text inside <pre> is emitted verbatim, never re-formatted', () => {
    // Markup inside the block is flattened to its text; token syntax and
    // formatting markers typed by the user survive as-is.
    expect(
      tiptapHtmlToTokens(
        '<pre><code>**raw** <strong>x</strong> &lt;@1&gt; `tick`\nline2</code></pre>'
      )
    ).toBe('```\n**raw** x <@1> `tick`\nline2\n```');
  });

  test('a paragraph after a code block starts on its own line', () => {
    expect(
      tiptapHtmlToTokens('<p>before</p><pre><code class="language-js">x</code></pre><p>after</p>')
    ).toBe('before\n```js\nx\n```\nafter');
  });

  test('blank-line collapsing stops at code fences', () => {
    expect(
      tiptapHtmlToTokens('<p>a</p><p></p><p></p><p></p><pre><code>x\n\n\n\ny</code></pre><p></p><p></p><p></p><p>b</p>')
    ).toBe('a\n\n```\nx\n\n\n\ny\n```\n\nb');
  });

  test('multi-line code keeps its internal newlines', () => {
    expect(
      tiptapHtmlToTokens('<pre><code class="language-py">a\n\n\nb</code></pre>')
    ).toBe('```py\na\n\n\nb\n```');
  });
});

describe('tiptapHtmlToTokens — blocks', () => {
  test('paragraphs are joined by a single newline', () => {
    expect(tiptapHtmlToTokens('<p>a</p><p>b</p>')).toBe('a\nb');
  });

  test('an empty paragraph is a blank line; runs of blank lines collapse', () => {
    expect(tiptapHtmlToTokens('<p>a</p><p></p><p>b</p>')).toBe('a\n\nb');
    expect(tiptapHtmlToTokens('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('trailing empty paragraphs are trimmed', () => {
    expect(tiptapHtmlToTokens('<p>a</p><p></p><p></p>')).toBe('a');
  });

  test('hard breaks become newlines', () => {
    expect(tiptapHtmlToTokens('<p>a<br>b</p>')).toBe('a\nb');
  });

  test('blockquote prefixes each paragraph with "> "', () => {
    expect(tiptapHtmlToTokens('<blockquote><p>a</p><p>b</p></blockquote>')).toBe(
      '> a\n> b'
    );
  });

  test('text after a blockquote is not absorbed into it', () => {
    expect(
      tiptapHtmlToTokens('<blockquote><p>q</p></blockquote><p>after</p>')
    ).toBe('> q\nafter');
  });

  test('formatting inside a blockquote is preserved', () => {
    expect(
      tiptapHtmlToTokens(`<blockquote><p><strong>b</strong> ${userMention(2, 'x')}</p></blockquote>`)
    ).toBe('> **b** <@2>');
  });

  test('lists, headings and rules', () => {
    expect(
      tiptapHtmlToTokens('<ul><li><p>one</p></li><li><p>two</p></li></ul>')
    ).toBe('- one\n- two');
    expect(
      tiptapHtmlToTokens('<ol><li><p>one</p></li><li><p>two</p></li></ol>')
    ).toBe('1. one\n2. two');
    expect(tiptapHtmlToTokens('<h2>Title</h2><p>body</p>')).toBe('## Title\nbody');
    expect(tiptapHtmlToTokens('<p>a</p><hr><p>b</p>')).toBe('a\n---\nb');
  });
});

describe('tiptapHtmlToTokens — links and text', () => {
  test('an auto-linked URL emits just the href', () => {
    expect(
      tiptapHtmlToTokens('<p><a href="https://x.y/p">https://x.y/p</a></p>')
    ).toBe('https://x.y/p');
  });

  test('an anchor whose text differs from its href keeps the label', () => {
    expect(tiptapHtmlToTokens('<p><a href="https://x.y">label</a></p>')).toBe(
      '[label](https://x.y)'
    );
  });

  test('an anchor without an href is plain text', () => {
    expect(tiptapHtmlToTokens('<p><a>no href</a></p>')).toBe('no href');
  });

  test('HTML entities in text decode to their characters', () => {
    expect(tiptapHtmlToTokens('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>')).toBe(
      '1 < 2 && 3 > 2'
    );
  });

  test('empty input is empty output', () => {
    expect(tiptapHtmlToTokens('')).toBe('');
    expect(tiptapHtmlToTokens('<p></p>')).toBe('');
  });

  test('unknown containers are walked through', () => {
    expect(tiptapHtmlToTokens('<div><p>in div</p></div>')).toBe('in div');
  });
});
