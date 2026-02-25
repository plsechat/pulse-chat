/**
 * Tests for the HTML → token format converter used in the migration script.
 * These tests import the converter logic extracted below for testability.
 */
import { describe, expect, test } from 'bun:test';

// ── Inline the converter functions for testing ───────────────
// (These are the same functions from migrate-html-to-tokens.ts)

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToTokens(html: string): string {
  if (!html) return '';

  let result = html;

  result = result.replace(
    /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string | undefined, code: string) => {
      const decoded = decodeEntities(code.replace(/<[^>]*>/g, ''));
      return `\`\`\`${lang ?? ''}\n${decoded}\n\`\`\``;
    }
  );

  result = result.replace(
    /<span[^>]*data-mention-type=["']user["'][^>]*data-mention-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<@$1>'
  );
  result = result.replace(
    /<span[^>]*data-mention-id=["'](\d+)["'][^>]*data-mention-type=["']user["'][^>]*>[^<]*<\/span>/g,
    '<@$1>'
  );

  result = result.replace(
    /<span[^>]*data-mention-type=["']role["'][^>]*data-mention-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<@&$1>'
  );
  result = result.replace(
    /<span[^>]*data-mention-id=["'](\d+)["'][^>]*data-mention-type=["']role["'][^>]*>[^<]*<\/span>/g,
    '<@&$1>'
  );

  result = result.replace(
    /<span[^>]*data-mention-type=["']all["'][^>]*>[^<]*<\/span>/g,
    '@everyone'
  );

  result = result.replace(
    /<span[^>]*data-type=["']channel-mention["'][^>]*data-channel-id=["'](\d+)["'][^>]*>[^<]*<\/span>/g,
    '<#$1>'
  );
  result = result.replace(
    /<span[^>]*data-channel-id=["'](\d+)["'][^>]*data-type=["']channel-mention["'][^>]*>[^<]*<\/span>/g,
    '<#$1>'
  );

  result = result.replace(
    /<img[^>]*data-emoji-name=["'](\w+)["'][^>]*data-emoji-id=["'](\d+)["'][^>]*\/?>/g,
    '<:$1:$2>'
  );
  result = result.replace(
    /<img[^>]*data-emoji-id=["'](\d+)["'][^>]*data-emoji-name=["'](\w+)["'][^>]*\/?>/g,
    '<:$2:$1>'
  );

  result = result.replace(
    /<img[^>]*class=["'][^"']*emoji-image[^"']*["'][^>]*alt=["']([^"']+)["'][^>]*\/?>/g,
    '$1'
  );
  result = result.replace(
    /<img[^>]*alt=["']([^"']+)["'][^>]*class=["'][^"']*emoji-image[^"']*["'][^>]*\/?>/g,
    '$1'
  );

  result = result.replace(
    /<blockquote>([\s\S]*?)<\/blockquote>/g,
    (_m, inner: string) => {
      const text = inner
        .replace(/<p>/g, '')
        .replace(/<\/p>/g, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      return text.split('\n').map((line) => `> ${line}`).join('\n');
    }
  );

  result = result.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  result = result.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**');
  result = result.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  result = result.replace(/<i>([\s\S]*?)<\/i>/g, '*$1*');
  result = result.replace(/<s>([\s\S]*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<del>([\s\S]*?)<\/del>/g, '~~$1~~');
  result = result.replace(/<u>([\s\S]*?)<\/u>/g, '__$1__');
  result = result.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');

  result = result.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>[^<]*<\/a>/g, '$1');

  result = result.replace(/<br\s*\/?>/g, '\n');
  result = result.replace(/<\/p>\s*<p>/g, '\n');
  result = result.replace(/<\/?p>/g, '');

  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  result = decodeEntities(result);

  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  return result;
}

// ── Tests ────────────────────────────────────────────────────

describe('htmlToTokens', () => {
  test('converts simple paragraph', () => {
    expect(htmlToTokens('<p>Hello world</p>')).toBe('Hello world');
  });

  test('converts multiple paragraphs', () => {
    expect(htmlToTokens('<p>Hello</p><p>world</p>')).toBe('Hello\nworld');
  });

  test('converts bold', () => {
    expect(htmlToTokens('<p><strong>bold text</strong></p>')).toBe(
      '**bold text**'
    );
  });

  test('converts italic', () => {
    expect(htmlToTokens('<p><em>italic text</em></p>')).toBe('*italic text*');
  });

  test('converts strikethrough', () => {
    expect(htmlToTokens('<p><s>struck</s></p>')).toBe('~~struck~~');
  });

  test('converts inline code', () => {
    expect(htmlToTokens('<p><code>code</code></p>')).toBe('`code`');
  });

  test('converts code block without language', () => {
    expect(htmlToTokens('<pre><code>const x = 1;</code></pre>')).toBe(
      '```\nconst x = 1;\n```'
    );
  });

  test('converts code block with language', () => {
    expect(
      htmlToTokens(
        '<pre><code class="language-js">const x = 1;</code></pre>'
      )
    ).toBe('```js\nconst x = 1;\n```');
  });

  test('converts user mention', () => {
    expect(
      htmlToTokens(
        '<p>Hey <span data-mention-type="user" data-mention-id="123" data-mention-name="John">@John</span></p>'
      )
    ).toBe('Hey <@123>');
  });

  test('converts role mention', () => {
    expect(
      htmlToTokens(
        '<p><span data-mention-type="role" data-mention-id="456" data-mention-name="Admin">@Admin</span></p>'
      )
    ).toBe('<@&456>');
  });

  test('converts @all mention', () => {
    expect(
      htmlToTokens(
        '<p><span data-mention-type="all" data-mention-id="0" data-mention-name="all">@all</span></p>'
      )
    ).toBe('@everyone');
  });

  test('converts channel mention', () => {
    expect(
      htmlToTokens(
        '<p><span data-type="channel-mention" data-channel-id="789" data-channel-name="general">#general</span></p>'
      )
    ).toBe('<#789>');
  });

  test('converts custom emoji', () => {
    expect(
      htmlToTokens(
        '<p><img class="emoji-image" data-emoji-name="fire" data-emoji-id="42" src="..." /></p>'
      )
    ).toBe('<:fire:42>');
  });

  test('converts link to bare URL', () => {
    expect(
      htmlToTokens(
        '<p><a href="https://example.com">https://example.com</a></p>'
      )
    ).toBe('https://example.com');
  });

  test('converts blockquote', () => {
    expect(
      htmlToTokens('<blockquote><p>quoted text</p></blockquote>')
    ).toBe('> quoted text');
  });

  test('decodes HTML entities', () => {
    expect(htmlToTokens('<p>A &amp; B &lt; C</p>')).toBe('A & B < C');
  });

  test('handles mixed content', () => {
    const html =
      '<p>Hey <span data-mention-type="user" data-mention-id="5" data-mention-name="Alice">@Alice</span>, check <strong>this</strong> out!</p>';
    expect(htmlToTokens(html)).toBe('Hey <@5>, check **this** out!');
  });

  test('returns empty for empty input', () => {
    expect(htmlToTokens('')).toBe('');
  });

  test('handles br tags', () => {
    expect(htmlToTokens('<p>line1<br>line2</p>')).toBe('line1\nline2');
  });

  test('idempotent on already-converted content', () => {
    const token = 'Hey <@5>, **bold** `code`';
    // Should pass through without <p> tags
    expect(htmlToTokens(token)).toBe(token);
  });
});
