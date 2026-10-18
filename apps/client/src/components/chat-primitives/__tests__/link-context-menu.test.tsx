/**
 * Right-click on a link inside a message: the "target inside an anchor"
 * predicate, and the capture handler that keeps the message menu closed
 * (and the default unprevented, so the browser's link menu shows) for
 * such hits while a hit on plain text still reaches the trigger.
 *
 * Run via: bun test apps/client/src/components/chat-primitives/__tests__/link-context-menu.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  hasNativeContextMenu,
  linkHrefFromTarget,
  useLinkContextMenu
} from '../link-context-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HREF = 'https://example.org/docs/page';

describe('linkHrefFromTarget', () => {
  let row: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    row = document.createElement('div');
    row.innerHTML = `
      <span class="text">plain text</span>
      <a href="${HREF}"><span class="inner">a <b>link</b></span></a>
      <a class="bare">no href</a>
      <a href="/relative">relative</a>`;
    document.body.appendChild(row);
  });

  test('the anchor itself and any descendant of it resolve to its href', () => {
    const anchor = row.querySelector(`a[href="${HREF}"]`)!;
    expect(linkHrefFromTarget(anchor, row)).toBe(HREF);
    expect(linkHrefFromTarget(row.querySelector('.inner'), row)).toBe(HREF);
    expect(linkHrefFromTarget(row.querySelector('b'), row)).toBe(HREF);
  });

  test('a relative href is a hit (browsers hand back the resolved URL)', () => {
    const rel = linkHrefFromTarget(row.querySelector('a[href="/relative"]'), row);
    expect(rel).toMatch(/\/relative$/);
  });

  test('plain text, an anchor without href, and non-element targets are not hits', () => {
    expect(linkHrefFromTarget(row.querySelector('.text'), row)).toBeNull();
    expect(linkHrefFromTarget(row.querySelector('a.bare'), row)).toBeNull();
    expect(linkHrefFromTarget(row, row)).toBeNull();
    expect(linkHrefFromTarget(null, row)).toBeNull();
    expect(linkHrefFromTarget(document.createTextNode('x'), row)).toBeNull();
    expect(linkHrefFromTarget(window, row)).toBeNull();
  });

  test('an anchor outside the root does not count', () => {
    const outer = document.createElement('a');
    outer.href = 'https://example.org/outer';
    const inner = document.createElement('div');
    outer.appendChild(inner);
    inner.appendChild(row);
    document.body.appendChild(outer);
    // The row sits inside a link, but the hit is bounded to the row.
    expect(linkHrefFromTarget(row.querySelector('.text'), row)).toBeNull();
    expect(linkHrefFromTarget(row.querySelector('.inner'), row)).toBe(HREF);
  });
});

describe('useLinkContextMenu', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let reachedTrigger = 0;

  // A stand-in for the radix trigger: a bubble-phase onContextMenu that
  // opens the menu and prevents the default, exactly as the real one does.
  const Row = () => {
    const { linkHref, triggerProps } = useLinkContextMenu();
    return createElement(
      'div',
      {
        ...triggerProps,
        'data-link': linkHref ?? '',
        onContextMenu: (e: { preventDefault: () => void }) => {
          reachedTrigger++;
          e.preventDefault();
        }
      },
      createElement('span', { className: 'text' }, 'plain text'),
      createElement('a', { href: HREF }, 'a link')
    );
  };

  const mount = () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Row)));
    return host.firstElementChild as HTMLDivElement;
  };

  const rightClick = (el: Element) => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2
    });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  };

  beforeEach(() => {
    reachedTrigger = 0;
    delete (window as { pulseDesktop?: unknown }).pulseDesktop;
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    delete (window as { pulseDesktop?: unknown }).pulseDesktop;
  });

  test('a hit on a link never reaches the trigger and keeps the default (native menu)', () => {
    const row = mount();
    const event = rightClick(row.querySelector('a')!);
    expect(reachedTrigger).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(row.getAttribute('data-link')).toBe(HREF);
  });

  test('a hit on plain text reaches the trigger as before', () => {
    const row = mount();
    const event = rightClick(row.querySelector('.text')!);
    expect(reachedTrigger).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(row.getAttribute('data-link')).toBe('');
  });

  test('the row itself (the keyboard target) reaches the trigger', () => {
    const row = mount();
    rightClick(row);
    expect(reachedTrigger).toBe(1);
    expect(row.getAttribute('data-link')).toBe('');
  });

  test('without a native menu (desktop shell) a link hit opens ours and remembers the link', () => {
    (window as { pulseDesktop?: unknown }).pulseDesktop = { isElectron: true };
    expect(hasNativeContextMenu()).toBe(false);
    const row = mount();
    const event = rightClick(row.querySelector('a')!);
    expect(reachedTrigger).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(row.getAttribute('data-link')).toBe(HREF);
  });

  test('a touch long-press remembers the link from pointerdown', () => {
    const row = mount();
    act(() => {
      row.querySelector('a')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })
      );
    });
    expect(row.getAttribute('data-link')).toBe(HREF);
    act(() => {
      row.querySelector('.text')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })
      );
    });
    expect(row.getAttribute('data-link')).toBe('');
  });
});
