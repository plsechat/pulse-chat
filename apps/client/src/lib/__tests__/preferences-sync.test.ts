/**
 * Preference writes are never dropped: a flush with no client or a
 * failed request re-queues the payload under anything newer, and the
 * server copy applied on the next join is overlaid with the queue so
 * a change made offline is not reverted.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_USER_PREFERENCES } from '@pulse/shared';
import {
  __testing,
  flushPreferencesNow,
  getPendingPreferences,
  syncPreference
} from '@/lib/preferences-sync';
import {
  applyServerPreferences,
  mergePendingPreferences
} from '@/lib/preferences-apply';
import { LocalStorageKey } from '@/helpers/storage';

type Sent = unknown[];
const clientThat = (
  sent: Sent,
  behaviour: 'ok' | 'fail' = 'ok'
) =>
  ({
    users: {
      updatePreferences: {
        mutate: async (input: unknown) => {
          if (behaviour === 'fail') throw new Error('boom');
          sent.push(input);
        }
      }
    }
  }) as never;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  __testing.reset();
  __testing.setDelays({ debounceMs: 5, retryMs: 5 });
});
afterEach(() => {
  __testing.reset();
});

describe('syncPreference / flushPreferencesNow', () => {
  test('a flush with no client keeps the payload and re-arms the timer', async () => {
    __testing.setClientResolver(() => null);
    syncPreference({ theme: 'dark' });
    await flushPreferencesNow();
    expect(getPendingPreferences()).toEqual({ theme: 'dark' });
    expect(__testing.hasTimer()).toBe(true);
  });

  test('sync(a); flush with null client; sync(b); client returns → ONE mutate with deepMerge(a, b)', async () => {
    __testing.setClientResolver(() => null);
    syncPreference({ theme: 'dark' });
    await flushPreferencesNow();

    syncPreference({ appearance: { fontScale: 110 } });

    const sent: Sent = [];
    __testing.setClientResolver(() => clientThat(sent));
    await flushPreferencesNow();

    expect(sent).toEqual([{ theme: 'dark', appearance: { fontScale: 110 } }]);
    expect(getPendingPreferences()).toEqual({});
    expect(__testing.hasTimer()).toBe(false);
  });

  test('a later value for the same key wins over the re-queued one', async () => {
    __testing.setClientResolver(() => null);
    syncPreference({ theme: 'dark' });
    await flushPreferencesNow();
    syncPreference({ theme: 'light' });

    const sent: Sent = [];
    __testing.setClientResolver(() => clientThat(sent));
    await flushPreferencesNow();
    expect(sent).toEqual([{ theme: 'light' }]);
  });

  test('a failed request re-queues and the retry timer sends it', async () => {
    const sent: Sent = [];
    let failing = true;
    __testing.setClientResolver(() =>
      clientThat(sent, failing ? 'fail' : 'ok')
    );
    syncPreference({ rightSidebarOpen: true });
    await flushPreferencesNow();
    expect(getPendingPreferences()).toEqual({ rightSidebarOpen: true });
    expect(__testing.hasTimer()).toBe(true);

    failing = false;
    await tick(30);
    expect(sent).toEqual([{ rightSidebarOpen: true }]);
    expect(getPendingPreferences()).toEqual({});
  });

  test('the debounce batches rapid writes into one request', async () => {
    const sent: Sent = [];
    __testing.setClientResolver(() => clientThat(sent));
    syncPreference({ serverChannelMap: { 1: 5 } });
    syncPreference({ serverChannelMap: { 2: 9 } });
    await tick(30);
    expect(sent).toEqual([{ serverChannelMap: { 1: 5, 2: 9 } }]);
  });
});

describe('applyServerPreferences', () => {
  test('queued local changes win over the server copy, then get pushed', async () => {
    __testing.setClientResolver(() => null);
    syncPreference({ theme: 'light', appearance: { fontScale: 120 } });
    await flushPreferencesNow();

    const sent: Sent = [];
    __testing.setClientResolver(() => clientThat(sent));
    applyServerPreferences({ ...DEFAULT_USER_PREFERENCES, theme: 'dark' });

    expect(localStorage.getItem(LocalStorageKey.VITE_UI_THEME)).toBe('light');
    expect(
      JSON.parse(localStorage.getItem(LocalStorageKey.APPEARANCE_SETTINGS)!)
    ).toEqual({ ...DEFAULT_USER_PREFERENCES.appearance, fontScale: 120 });
    // Untouched keys come from the server as before.
    expect(
      JSON.parse(localStorage.getItem(LocalStorageKey.SOUND_NOTIFICATION_SETTINGS)!)
    ).toEqual(DEFAULT_USER_PREFERENCES.soundNotification);

    await tick(0);
    expect(sent).toEqual([{ theme: 'light', appearance: { fontScale: 120 } }]);
  });

  test('mergePendingPreferences is a no-op with nothing queued', () => {
    expect(mergePendingPreferences(DEFAULT_USER_PREFERENCES, {})).toEqual(
      DEFAULT_USER_PREFERENCES
    );
  });
});
