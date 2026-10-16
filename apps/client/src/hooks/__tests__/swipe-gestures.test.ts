/**
 * The swipe decision behind the mobile drawers. The old handler took any
 * 50 px of horizontal travel as a swipe: a diagonal scroll through the
 * message list, a drag across a code block, a slider thumb and even a
 * touch inside a popover (React events bubble through portals) all
 * flipped the drawers.
 *
 * Run via:
 *   bun test apps/client/src/hooks/__tests__/swipe-gestures.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  decideSwipe,
  hasHorizontalScrollAncestor,
  isSwipeBlockedTarget,
  type TSwipeGesture
} from '@/hooks/use-swipe-gestures';

const gesture = (over: Partial<TSwipeGesture>): TSwipeGesture => ({
  dx: 0,
  dy: 0,
  blocked: false,
  fromEdge: false,
  horizontalScroll: false,
  ...over
});

describe('decideSwipe', () => {
  test('a clear horizontal drag past the threshold is a swipe', () => {
    expect(decideSwipe(gesture({ dx: 80, dy: 10 }))).toBe('right');
    expect(decideSwipe(gesture({ dx: -80, dy: -10 }))).toBe('left');
  });

  test('short travel is not a swipe', () => {
    expect(decideSwipe(gesture({ dx: 49 }))).toBeNull();
    expect(decideSwipe(gesture({ dx: -49 }))).toBeNull();
  });

  test('a diagonal drag (|dx| not > 1.5·|dy|) is a scroll, not a swipe', () => {
    expect(decideSwipe(gesture({ dx: 90, dy: 60 }))).toBeNull();
    expect(decideSwipe(gesture({ dx: 90, dy: 59 }))).toBe('right');
    expect(decideSwipe(gesture({ dx: 60, dy: -200 }))).toBeNull();
  });

  test('a blocked target never swipes, however far it travelled', () => {
    expect(decideSwipe(gesture({ dx: 300, blocked: true }))).toBeNull();
  });

  test('inside a horizontal scroller only an edge start counts', () => {
    expect(
      decideSwipe(gesture({ dx: 120, horizontalScroll: true }))
    ).toBeNull();
    expect(
      decideSwipe(gesture({ dx: 120, horizontalScroll: true, fromEdge: true }))
    ).toBe('right');
  });
});

describe('target filters', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const mount = (html: string): HTMLElement => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  };

  test('blocks code blocks, sliders, text inputs and opt-outs (by ancestor)', () => {
    const root = mount(`
      <pre><code><span id="code">x</span></code></pre>
      <div role="slider"><span id="thumb"></span></div>
      <input id="input" />
      <div contenteditable="true"><p id="editor">hi</p></div>
      <div data-no-swipe><span id="optout"></span></div>
      <p id="plain">text</p>
    `);
    for (const id of ['code', 'thumb', 'input', 'editor', 'optout']) {
      expect(isSwipeBlockedTarget(root.querySelector(`#${id}`), root)).toBe(
        true
      );
    }
    expect(isSwipeBlockedTarget(root.querySelector('#plain'), root)).toBe(
      false
    );
  });

  test('blocks targets outside the root (portals) and non-elements', () => {
    const root = mount('<p id="inside"></p>');
    const portal = mount('<div id="portal"><button id="menu"></button></div>');
    expect(isSwipeBlockedTarget(portal.querySelector('#menu'), root)).toBe(
      true
    );
    expect(isSwipeBlockedTarget(null, root)).toBe(true);
    const textNode = root.querySelector('#inside')!.appendChild(
      document.createTextNode('t')
    );
    // A text node resolves to its parent element.
    expect(isSwipeBlockedTarget(textNode, root)).toBe(false);
  });

  test('detects a horizontally scrollable ancestor between target and root', () => {
    const root = mount(
      '<div id="strip" style="overflow-x: auto"><span id="card"></span></div><div id="static"><span id="plain"></span></div>'
    );
    const strip = root.querySelector('#strip') as HTMLElement;
    // happy-dom has no layout: give the scroller real metrics.
    Object.defineProperty(strip, 'scrollWidth', { value: 900 });
    Object.defineProperty(strip, 'clientWidth', { value: 400 });
    expect(hasHorizontalScrollAncestor(root.querySelector('#card'), root)).toBe(
      true
    );
    expect(
      hasHorizontalScrollAncestor(root.querySelector('#plain'), root)
    ).toBe(false);
  });

  test('a wide element that is clipped (overflow hidden) does not count', () => {
    const root = mount(
      '<div id="clip" style="overflow-x: hidden"><span id="t"></span></div>'
    );
    const clip = root.querySelector('#clip') as HTMLElement;
    Object.defineProperty(clip, 'scrollWidth', { value: 900 });
    Object.defineProperty(clip, 'clientWidth', { value: 400 });
    expect(hasHorizontalScrollAncestor(root.querySelector('#t'), root)).toBe(
      false
    );
  });
});
