/**
 * createPreferenceStore (A10-10 #14): lazy read with defaults, write-through
 * to localStorage, onChange BEFORE listeners, the partial queued for the
 * server under the sync key, and `preferences-loaded` dropping the cache.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LocalStorageKey } from '@/helpers/storage';
import { emitAppEvent } from '@/lib/events';
import { createPreferenceStore } from '@/lib/preference-store';
import { __testing as sync, getPendingPreferences } from '@/lib/preferences-sync';

type Prefs = { a: number; b: string };
const KEY = LocalStorageKey.VOLUME_SETTINGS;
const defaults: Prefs = { a: 1, b: 'x' };

beforeEach(() => {
  localStorage.removeItem(KEY);
  sync.reset();
  // No client: everything queued stays visible in getPendingPreferences.
  sync.setClientResolver(() => null);
  sync.setDelays({ debounceMs: 60_000 });
});
afterEach(() => {
  localStorage.removeItem(KEY);
  sync.reset();
});

describe('createPreferenceStore', () => {
  test('reads lazily, falling back to the defaults', () => {
    const store = createPreferenceStore<Prefs>({ storageKey: KEY, defaults, syncKey: 'volume' });
    expect(store.getSettings()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ a: 5, b: 'y' }));
    // Cached: the first read sticks until preferences-loaded.
    expect(store.getSettings()).toEqual(defaults);
  });

  test('a stored object missing a key reads the default for that key', () => {
    // An appearance object saved before `layout` existed must not pin
    // the user to the pre-upgrade behaviour until they toggle the setting.
    localStorage.setItem(KEY, JSON.stringify({ a: 5 }));
    const store = createPreferenceStore<Prefs>({ storageKey: KEY, defaults, syncKey: 'volume' });
    expect(store.getSettings()).toEqual({ a: 5, b: 'x' });
    // A stored key still wins over the default.
    localStorage.setItem(KEY, JSON.stringify({ a: 5, b: 'y' }));
    emitAppEvent('preferences-loaded');
    expect(store.getSettings()).toEqual({ a: 5, b: 'y' });
  });

  test('updateSettings merges, persists, fires onChange before listeners, queues the sync', () => {
    const order: string[] = [];
    const store = createPreferenceStore<Prefs>({
      storageKey: KEY,
      defaults,
      syncKey: 'volume',
      onChange: () => order.push('onChange')
    });
    store.subscribe(() => order.push('listener'));

    store.updateSettings({ a: 2 });

    expect(store.getSettings()).toEqual({ a: 2, b: 'x' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ a: 2, b: 'x' });
    expect(order).toEqual(['onChange', 'listener']);
    expect(getPendingPreferences()).toEqual({ volume: { a: 2 } } as never);
  });

  test('preferences-loaded drops the cache and re-notifies', () => {
    const seen: Prefs[] = [];
    let notified = 0;
    const store = createPreferenceStore<Prefs>({
      storageKey: KEY,
      defaults,
      syncKey: 'volume',
      onChange: (s) => seen.push(s)
    });
    store.subscribe(() => notified++);
    expect(store.getSettings()).toEqual(defaults);

    localStorage.setItem(KEY, JSON.stringify({ a: 9, b: 'z' }));
    emitAppEvent('preferences-loaded');

    expect(store.getSettings()).toEqual({ a: 9, b: 'z' });
    expect(seen).toEqual([{ a: 9, b: 'z' }]);
    expect(notified).toBe(1);
    // A server-applied value is not re-queued for the server.
    expect(getPendingPreferences()).toEqual({});
  });

  test('unsubscribe stops notifications', () => {
    const store = createPreferenceStore<Prefs>({ storageKey: KEY, defaults, syncKey: 'volume' });
    let n = 0;
    const off = store.subscribe(() => n++);
    store.updateSettings({ b: 'q' });
    off();
    store.updateSettings({ b: 'r' });
    expect(n).toBe(1);
  });
});
