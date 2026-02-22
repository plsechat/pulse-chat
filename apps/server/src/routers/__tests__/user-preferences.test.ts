import { DEFAULT_USER_PREFERENCES } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { userPreferences } from '../../db/schema';

describe('user preferences', () => {
  test('getPreferences returns defaults when no row exists', async () => {
    const { caller } = await initTest();

    const prefs = await caller.users.getPreferences();

    expect(prefs).toEqual(DEFAULT_USER_PREFERENCES);
  });

  test('updatePreferences creates a new row with merged defaults', async () => {
    const { caller } = await initTest();

    const result = await caller.users.updatePreferences({
      appearance: { compactMode: true }
    });

    expect(result.appearance.compactMode).toBe(true);
    // Other appearance fields should retain defaults
    expect(result.appearance.messageSpacing).toBe('normal');
    expect(result.appearance.fontScale).toBe(100);
    expect(result.appearance.zoomLevel).toBe(100);
    expect(result.appearance.timeFormat).toBe('12h');
    // Other categories should retain defaults
    expect(result.soundNotification).toEqual(
      DEFAULT_USER_PREFERENCES.soundNotification
    );
    expect(result.theme).toBe('dark');
  });

  test('updatePreferences merges partial updates correctly', async () => {
    const { caller } = await initTest();

    // First update
    await caller.users.updatePreferences({
      appearance: { compactMode: true, fontScale: 120 }
    });

    // Second update — only change one field
    const result = await caller.users.updatePreferences({
      appearance: { fontScale: 140 }
    });

    // compactMode should still be true from first update
    expect(result.appearance.compactMode).toBe(true);
    expect(result.appearance.fontScale).toBe(140);
  });

  test('updatePreferences merges serverChannelMap additively', async () => {
    const { caller } = await initTest();

    await caller.users.updatePreferences({
      serverChannelMap: { 'server-1': 5 }
    });

    const result = await caller.users.updatePreferences({
      serverChannelMap: { 'server-2': 10 }
    });

    expect(result.serverChannelMap).toEqual({
      'server-1': 5,
      'server-2': 10
    });
  });

  test('updatePreferences replaces scalar values', async () => {
    const { caller } = await initTest();

    await caller.users.updatePreferences({ theme: 'onyx' });
    const result = await caller.users.updatePreferences({ theme: 'light' });

    expect(result.theme).toBe('light');
  });

  test('full round-trip: update then get returns same data', async () => {
    const { caller } = await initTest();

    const updated = await caller.users.updatePreferences({
      appearance: { compactMode: true, timeFormat: '24h' },
      soundNotification: { masterVolume: 50 },
      theme: 'onyx',
      rightSidebarOpen: true
    });

    const fetched = await caller.users.getPreferences();

    expect(fetched).toEqual(updated);
  });

  test('preferences are included in join response', async () => {
    const { caller } = await initTest();

    // Set some preferences
    await caller.users.updatePreferences({ theme: 'onyx' });

    // Re-join and check preferences are present
    const { initialData } = await initTest();

    expect(initialData.userPreferences).toBeDefined();
    expect(initialData.userPreferences!.theme).toBe('onyx');
  });

  test('join response has undefined userPreferences for new user', async () => {
    // User 2 has no preferences set
    const tdb = getTestDb();
    await tdb
      .delete(userPreferences)
      .where(eq(userPreferences.userId, 2));

    const { initialData } = await initTest(2);

    expect(initialData.userPreferences).toBeUndefined();
  });

  test('rejects invalid fontScale values', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.updatePreferences({
        appearance: { fontScale: 300 }
      })
    ).rejects.toThrow();
  });

  test('rejects invalid masterVolume values', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.updatePreferences({
        soundNotification: { masterVolume: -1 }
      })
    ).rejects.toThrow();
  });
});
