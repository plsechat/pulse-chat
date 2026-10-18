import { describe, expect, test } from 'bun:test';
import { getPlainTextFromHtml } from '../get-plain-text-from-html';

/**
 * getPlainTextFromHtml feeds the forum card `contentPreview` (and the
 * forum search that filters on it) and the plugin command-arg parser.
 * Forum posts are raw markdown from a plain textarea, so the token path
 * has to read as plain text while leaving code spans and bare URLs
 * (command arguments) untouched.
 */

describe('getPlainTextFromHtml — legacy HTML path (unchanged)', () => {
  test('tags are stripped, entities decoded, text trimmed', () => {
    expect(getPlainTextFromHtml('<p>Hello <strong>world</strong></p>')).toBe(
      'Hello world'
    );
    expect(
      getPlainTextFromHtml('<p>Tom &amp; Jerry 1 &lt; 2 &quot;q&quot; it&#39;s a&nbsp;b</p>')
    ).toBe('Tom & Jerry 1 < 2 "q" it\'s a b');
  });

  test('nested and malformed tags never leave a tag behind', () => {
    for (const html of [
      '<p><<b>script>alert(1)</b></p>',
      '<p><s<b>cript>x</p>',
      '<p>x<img src=x onerror=alert(1)>y</p>'
    ]) {
      expect(getPlainTextFromHtml(html)).not.toMatch(/<[^>]*>/);
    }
  });

  test('markdown inside legacy HTML is left alone', () => {
    expect(getPlainTextFromHtml('<p>keep **raw** here</p>')).toBe(
      'keep **raw** here'
    );
  });
});

describe('getPlainTextFromHtml — token path', () => {
  test('mention, channel and emoji tokens are still removed', () => {
    expect(getPlainTextFromHtml('hi <@1> <@&2> <#3> <:party:42> there')).toBe(
      'hi     there'
    );
  });

  test('a typical forum post body reads as plain text', () => {
    expect(getPlainTextFromHtml('# Title\n**bold** [link](http://x)')).toBe(
      'Title\nbold link'
    );
  });

  test('ATX headings lose their hashes', () => {
    expect(getPlainTextFromHtml('# H1\n## H2\n###### H6\nbody')).toBe(
      'H1\nH2\nH6\nbody'
    );
    // a hash without the space is a hashtag, not a heading
    expect(getPlainTextFromHtml('#topic')).toBe('#topic');
  });

  test('block quotes, nested too, lose their chevrons', () => {
    expect(getPlainTextFromHtml('> quoted\n> > nested\nplain')).toBe(
      'quoted\nnested\nplain'
    );
  });

  test('paired inline markers are removed and the text kept', () => {
    expect(getPlainTextFromHtml('**b** *i* ~~s~~ __u__ ||sp|| _e_')).toBe(
      'b i s u sp e'
    );
    expect(getPlainTextFromHtml('***both***')).toBe('both');
  });

  test('code spans keep their text and shield their contents', () => {
    expect(getPlainTextFromHtml('run `npm i` now')).toBe('run npm i now');
    expect(getPlainTextFromHtml('`**not bold** _x_`')).toBe('**not bold** _x_');
  });

  test('fenced blocks keep the code and drop the fences and language', () => {
    expect(getPlainTextFromHtml('```js\nconst a = 1;\n```\nafter')).toBe(
      'const a = 1;\nafter'
    );
    expect(getPlainTextFromHtml('```one```')).toBe('one');
    expect(getPlainTextFromHtml('```\nunclosed')).toBe('unclosed');
  });

  test('links and images collapse to their text', () => {
    expect(getPlainTextFromHtml('[docs](https://x.y/a_b) and ![alt](https://x/y.png)')).toBe(
      'docs and alt'
    );
    expect(getPlainTextFromHtml('[t](https://u "title")')).toBe('t');
  });

  test('list markers and task boxes go', () => {
    expect(
      getPlainTextFromHtml('- a\n* b\n+ c\n1. d\n2) e\n  - nested\n- [ ] f\n- [x] g')
    ).toBe('a\nb\nc\nd\ne\nnested\nf\ng');
  });

  test('horizontal rules vanish with their line', () => {
    expect(getPlainTextFromHtml('above\n---\nbelow\n***\n___\n- - -')).toBe(
      'above\nbelow'
    );
  });

  test('bare URLs survive untouched, including underscores and asterisks', () => {
    const url = 'https://www.youtube.com/watch?v=_ab_cd_&x=__y__*z*';
    expect(getPlainTextFromHtml(`see ${url} now`)).toBe(`see ${url} now`);
    expect(getPlainTextFromHtml(`/watch ${url}`)).toBe(`/watch ${url}`);
  });

  test('snake_case, lone asterisks and spaced operators are plain text', () => {
    expect(getPlainTextFromHtml('snake_case_name stays')).toBe('snake_case_name stays');
    expect(getPlainTextFromHtml('5 * 3 = 15 and a * b')).toBe('5 * 3 = 15 and a * b');
    expect(getPlainTextFromHtml('* lone star line')).toBe('lone star line');
    expect(getPlainTextFromHtml('-5 degrees and 2024. A year')).toBe(
      '-5 degrees and 2024. A year'
    );
    expect(getPlainTextFromHtml('unterminated **bold')).toBe('unterminated **bold');
    expect(getPlainTextFromHtml('a || b')).toBe('a || b');
  });

  test('result is trimmed', () => {
    expect(getPlainTextFromHtml('  \n# x \n ')).toBe('x');
  });
});
