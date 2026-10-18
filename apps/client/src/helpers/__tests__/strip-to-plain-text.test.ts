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

  test('paired formatting markers are removed and the text kept', () => {
    expect(stripToPlainText('**b** *i* ~~s~~ __u__ `c` ||sp|| _e_')).toBe('b i s u c sp e');
    expect(stripToPlainText('***both***')).toBe('both');
  });

  test('fenced blocks keep the code and drop the fences and language', () => {
    expect(stripToPlainText('```js\ncode\n```')).toBe('code');
    expect(stripToPlainText('```one```')).toBe('one');
    expect(stripToPlainText('```\nunclosed')).toBe('unclosed');
  });

  test('code spans shield their contents from the markdown pass', () => {
    expect(stripToPlainText('`**not bold** _x_`')).toBe('**not bold** _x_');
  });

  test('a forum post body reads as plain text', () => {
    expect(stripToPlainText('# Title\n**bold** [link](http://x)')).toBe('Title\nbold link');
  });

  test('headings, quotes, list markers and rules go', () => {
    expect(stripToPlainText('# H1\n## H2\nbody')).toBe('H1\nH2\nbody');
    expect(stripToPlainText('#topic')).toBe('#topic');
    expect(stripToPlainText('> quoted\n> > nested\nplain')).toBe('quoted\nnested\nplain');
    expect(stripToPlainText('- a\n* b\n+ c\n1. d\n2) e\n  - nested\n- [ ] f\n- [x] g')).toBe(
      'a\nb\nc\nd\ne\nnested\nf\ng'
    );
    expect(stripToPlainText('above\n---\nbelow\n***\n___')).toBe('above\nbelow');
  });

  test('links and images collapse to their text', () => {
    expect(stripToPlainText('[docs](https://x.y/a_b) and ![alt](https://x/y.png)')).toBe(
      'docs and alt'
    );
    expect(stripToPlainText('[t](https://u "title")')).toBe('t');
  });

  test('@everyone and bare URLs are left as readable text', () => {
    expect(stripToPlainText('@everyone see https://x.y')).toBe('@everyone see https://x.y');
    const url = 'https://www.youtube.com/watch?v=_ab_cd_&x=__y__*z*';
    expect(stripToPlainText(`see ${url} now`)).toBe(`see ${url} now`);
  });

  test('snake_case, lone asterisks and spaced operators are plain text', () => {
    expect(stripToPlainText('snake_case_name stays')).toBe('snake_case_name stays');
    expect(stripToPlainText('5 * 3 = 15 and a * b')).toBe('5 * 3 = 15 and a * b');
    expect(stripToPlainText('* lone star line')).toBe('lone star line');
    expect(stripToPlainText('-5 degrees and 2024. A year')).toBe('-5 degrees and 2024. A year');
    expect(stripToPlainText('unterminated **bold')).toBe('unterminated **bold');
    expect(stripToPlainText('a || b')).toBe('a || b');
  });

  test('mention placeholders survive the markdown pass', () => {
    expect(stripToPlainText('**<@1>** said _<#3>_')).toBe('@user said #channel');
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
