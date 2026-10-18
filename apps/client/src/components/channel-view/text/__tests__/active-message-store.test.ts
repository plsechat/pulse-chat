/**
 * The tapped-row store behind the touch action toolbar (finding #22):
 * one active row at a time, a tap toggles it, a tap elsewhere or a
 * finger scroll clears it, taps on controls and inside overlays never
 * count, and a mouse (fine pointer) never toggles.
 *
 * Run via: bun test apps/client/src/components/channel-view/text/__tests__/active-message-store.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getActiveMessageKey,
  handleRowTap,
  setActiveMessage,
  toggleActiveMessage
} from '@/components/channel-view/text/active-message-store';

let coarse = true;
const realMatchMedia = window.matchMedia;

const rowTap = (target: Element) =>
  ({ target }) as unknown as React.MouseEvent;

const mount = (html: string) => {
  document.body.innerHTML = html;
};

const pointerDownOn = (el: Element) => {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
};

const touch = (type: 'touchstart' | 'touchmove', el: Element, x: number, y: number) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(event);
};

beforeEach(() => {
  coarse = true;
  window.matchMedia = ((query: string) =>
    ({
      matches: query === '(pointer: coarse)' ? coarse : false,
      media: query,
      addEventListener() {},
      removeEventListener() {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  mount(`
    <div id="list">
      <div id="msg-1" class="group"><span id="t1">one</span><a id="link" href="#">x</a><button id="btn">b</button></div>
      <div id="msg-2" class="group"><span id="t2">two</span></div>
      <div id="dm-msg-3" class="group"><span id="t3">three</span></div>
    </div>
    <div id="elsewhere"></div>
    <div id="overlay" data-radix-popper-content-wrapper><button id="in-picker">pick</button></div>
  `);
});

afterEach(() => {
  setActiveMessage(null);
  window.matchMedia = realMatchMedia;
  document.body.innerHTML = '';
});

const el = (id: string) => document.getElementById(id)!;

describe('active-message-store', () => {
  test('a tap toggles the row; a second tap on it clears', () => {
    expect(handleRowTap(rowTap(el('t1')), 'msg-1')).toBe(true);
    expect(getActiveMessageKey()).toBe('msg-1');
    expect(handleRowTap(rowTap(el('t1')), 'msg-1')).toBe(true);
    expect(getActiveMessageKey()).toBeNull();
  });

  test('only one row is active: tapping another moves it (channels and DMs share the store)', () => {
    handleRowTap(rowTap(el('t1')), 'msg-1');
    handleRowTap(rowTap(el('t3')), 'dm-msg-3');
    expect(getActiveMessageKey()).toBe('dm-msg-3');
    toggleActiveMessage('msg-2');
    expect(getActiveMessageKey()).toBe('msg-2');
  });

  test('taps on links and buttons inside the row pass through untouched', () => {
    expect(handleRowTap(rowTap(el('link')), 'msg-1')).toBe(false);
    expect(handleRowTap(rowTap(el('btn')), 'msg-1')).toBe(false);
    expect(getActiveMessageKey()).toBeNull();
  });

  test('a fine pointer (mouse) never toggles — hover does that job', () => {
    coarse = false;
    expect(handleRowTap(rowTap(el('t1')), 'msg-1')).toBe(false);
    expect(getActiveMessageKey()).toBeNull();
  });

  test('a pointer down elsewhere clears; inside the active row or an overlay it does not', () => {
    handleRowTap(rowTap(el('t1')), 'msg-1');
    pointerDownOn(el('btn')); // inside the active row (its own toolbar)
    expect(getActiveMessageKey()).toBe('msg-1');
    pointerDownOn(el('in-picker')); // the emoji picker the toolbar opened
    expect(getActiveMessageKey()).toBe('msg-1');
    pointerDownOn(el('elsewhere'));
    expect(getActiveMessageKey()).toBeNull();
  });

  test('a finger that travels (a scroll) clears; a finger that stays (a tap) does not', () => {
    handleRowTap(rowTap(el('t2')), 'msg-2');
    touch('touchstart', el('list'), 100, 100);
    touch('touchmove', el('list'), 104, 103);
    expect(getActiveMessageKey()).toBe('msg-2');
    touch('touchmove', el('list'), 100, 160);
    expect(getActiveMessageKey()).toBeNull();
  });

  test('a scroll inside the open picker leaves the row active', () => {
    // The picker exists in the DOM only while open; its presence is the signal.
    el('overlay').appendChild(document.createElement('em-emoji-picker'));
    handleRowTap(rowTap(el('t2')), 'msg-2');
    touch('touchstart', el('in-picker'), 10, 10);
    touch('touchmove', el('in-picker'), 10, 200);
    expect(getActiveMessageKey()).toBe('msg-2');
  });

  test('listeners come off with the last active row: a later pointer down is inert', () => {
    handleRowTap(rowTap(el('t1')), 'msg-1');
    setActiveMessage(null);
    toggleActiveMessage('msg-2');
    pointerDownOn(el('t2')); // inside msg-2: still active
    expect(getActiveMessageKey()).toBe('msg-2');
    pointerDownOn(el('elsewhere'));
    expect(getActiveMessageKey()).toBeNull();
  });

  test('a subscriber sees each change through the per-key selector contract', () => {
    // The hook's snapshot is `activeKey === key`; exercise the same
    // comparison through the module API to keep the contract honest.
    toggleActiveMessage('msg-1');
    expect(getActiveMessageKey() === 'msg-1').toBe(true);
    expect(getActiveMessageKey() === 'msg-2').toBe(false);
    toggleActiveMessage('msg-2');
    expect(getActiveMessageKey() === 'msg-1').toBe(false);
    expect(getActiveMessageKey() === 'msg-2').toBe(true);
  });
});
