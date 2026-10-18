/**
 * The tag chip editor: what typing commits, what it refuses, and the
 * keyboard/paste behaviour on a mounted field.
 *
 * Run via: bun test apps/client/src/components/ui/__tests__/tag-input.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { commitTags, splitTagText, TagInput } from '../tag-input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const rules = {
  max: 5,
  maxLength: 24,
  pattern: /^[\p{L}\p{N} _-]+$/u
};

describe('commitTags', () => {
  test('splits on commas and newlines, trims, drops the # and empties', () => {
    expect(splitTagText(' #casual, Ranked ,\n pvp,, ')).toEqual(['casual', 'Ranked', 'pvp']);
    expect(commitTags([], 'casual, ranked', rules)).toEqual({
      tags: ['casual', 'ranked'],
      error: undefined
    });
  });

  test('deduplicates case-insensitively against the existing chips and within the paste', () => {
    expect(commitTags(['Casual'], 'casual, PVP, pvp', rules).tags).toEqual(['Casual', 'PVP']);
  });

  test('stops at the maximum and says so', () => {
    const result = commitTags(['a', 'b', 'c', 'd'], 'e, f', rules);
    expect(result.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.error).toBe('Up to 5 tags');
  });

  test('refuses an over-long tag and a tag with other characters, keeping the good ones', () => {
    const long = commitTags([], `${'x'.repeat(25)}, ok`, rules);
    expect(long.tags).toEqual(['ok']);
    expect(long.error).toBe('Each tag can be up to 24 characters');

    const chars = commitTags([], 'nope!, co-op, late night, Überzahl', rules);
    expect(chars.tags).toEqual(['co-op', 'late night', 'Überzahl']);
    expect(chars.error).toBe('Tags may contain letters, numbers, spaces, _ and -');
  });
});

describe('<TagInput>', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let value: string[] = [];

  const render = () => {
    const Probe = () => (
      <TagInput
        value={value}
        onChange={(next) => {
          value = next;
          rerender();
        }}
        aria-label="Tags"
        {...rules}
      />
    );
    const rerender = () => act(() => root!.render(<Probe />));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rerender();
  };

  const input = () => container!.querySelector('input')!;
  const chips = () =>
    [...container!.querySelectorAll('button[aria-label^="Remove tag "]')].map((b) =>
      b.getAttribute('aria-label')!.replace('Remove tag ', '')
    );

  const type = (text: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(input(), text);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });

  const key = (k: string) =>
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
      );
    });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    value = [];
  });

  test('Enter and comma commit a chip shown with a #; Backspace on an empty field removes the last', () => {
    render();
    type('casual');
    key('Enter');
    expect(value).toEqual(['casual']);
    expect(chips()).toEqual(['casual']);
    expect(container!.textContent).toContain('#casual');
    expect(input().value).toBe('');

    type('ranked');
    key(',');
    expect(value).toEqual(['casual', 'ranked']);
    expect(container!.textContent).toContain('2/5');

    key('Backspace');
    expect(value).toEqual(['casual']);
  });

  test('a refused tag stays in the field with the reason, and the remove button drops a chip', () => {
    render();
    type('nope!');
    key('Enter');
    expect(value).toEqual([]);
    expect(input().value).toBe('nope!');
    expect(container!.querySelector('[role="alert"]')!.textContent).toContain(
      'letters, numbers, spaces'
    );

    type('fine');
    key('Enter');
    act(() => {
      (container!.querySelector('button[aria-label="Remove tag fine"]') as HTMLButtonElement).click();
    });
    expect(value).toEqual([]);
  });

  test('the field closes once the maximum is reached', () => {
    value = ['a', 'b', 'c', 'd', 'e'];
    render();
    expect(input().disabled).toBe(true);
    expect(container!.textContent).toContain('5/5');
  });
});
