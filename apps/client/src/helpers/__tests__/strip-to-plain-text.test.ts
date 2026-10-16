/**
 * stripToPlainText feeds reply previews, notifications, sidebar previews
 * and copy-text; isTokenContentEmpty is the composer's send guard.
 *
 * Run via: bun test apps/client/src/helpers/__tests__/strip-to-plain-text.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { isTokenContentEmpty, stripToPlainText } from '../strip-to-plain-text';

describe('stripToPlainText — legacy HTML', () => {
  test('tags are stripped and the text trimmed', () => {
    expect(stripToPlainText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    expect(stripToPlainText('<p> spaced </p>')).toBe('spaced');
  });

  test('nested and malformed tags never leave a tag behind', () => {
    for (const html of [
      '<p><<b>script>alert(1)</b></p>',
      '<p><s<b>cript>x</p>',
      '<p>a<b<c>d</p>',
      '<p>x<img src=x onerror=alert(1)>y</p>'
    ]) {
      const out = stripToPlainText(html);
      expect(out).not.toMatch(/<[^>]*>/);
      expect(out).not.toContain('<script>');
    }
  });

  test('entities the editor emits decode to their characters', () => {
    expect(stripToPlainText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
    expect(stripToPlainText('<p>1 &lt; 2 &gt; 0 &quot;q&quot; it&#39;s a&nbsp;b</p>')).toBe(
      '1 < 2 > 0 "q" it\'s a b'
    );
  });

  test('a doubly-escaped entity decodes exactly one level', () => {
    expect(stripToPlainText('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
  });
});

describe('stripToPlainText — token format', () => {
  test('mentions, channels and custom emoji become readable placeholders', () => {
    expect(stripToPlainText('hi <@1> and <@&2> in <#3> <:party:42>')).toBe(
      'hi @user and @role in #channel :party:'
    );
  });

  test('formatting markers are removed', () => {
    expect(stripToPlainText('**b** *i* ~~s~~ __u__ `c`')).toBe('b i s u c');
    expect(stripToPlainText('```js\ncode\n```')).toBe('js\ncode');
  });

  test('@everyone and links are left as readable text', () => {
    expect(stripToPlainText('@everyone see https://x.y')).toBe('@everyone see https://x.y');
  });

  test('null, undefined and empty are empty', () => {
    expect(stripToPlainText(null)).toBe('');
    expect(stripToPlainText(undefined)).toBe('');
    expect(stripToPlainText('')).toBe('');
  });

  test('token text is not entity-decoded (it was never encoded)', () => {
    expect(stripToPlainText('a &amp; b')).toBe('a &amp; b');
  });
});

describe('isTokenContentEmpty — composer send guard', () => {
  test('empty and whitespace-only content is empty', () => {
    expect(isTokenContentEmpty('')).toBe(true);
    expect(isTokenContentEmpty('   ')).toBe(true);
    expect(isTokenContentEmpty('\n\n')).toBe(true);
  });

  test('formatting-only content is empty', () => {
    expect(isTokenContentEmpty('** **')).toBe(true);
    expect(isTokenContentEmpty('~~~~')).toBe(true);
    expect(isTokenContentEmpty('``')).toBe(true);
    expect(isTokenContentEmpty('> ')).toBe(true);
    expect(isTokenContentEmpty('```\n\n```')).toBe(true);
  });

  test('a lone custom emoji or mention is a real message', () => {
    expect(isTokenContentEmpty('<:party:42>')).toBe(false);
    expect(isTokenContentEmpty('<@1>')).toBe(false);
    expect(isTokenContentEmpty('<@&1>')).toBe(false);
    expect(isTokenContentEmpty('<#1>')).toBe(false);
    expect(isTokenContentEmpty('@everyone')).toBe(false);
  });

  test('any text is a real message', () => {
    expect(isTokenContentEmpty('a')).toBe(false);
    expect(isTokenContentEmpty('**a**')).toBe(false);
    expect(isTokenContentEmpty('🎉')).toBe(false);
    expect(isTokenContentEmpty('<#msg:1/2>')).toBe(false);
  });
});
