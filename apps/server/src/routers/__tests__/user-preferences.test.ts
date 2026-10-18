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

  test('appearance.layout round-trips and rejects unknown layouts', async () => {
    const { caller } = await initTest();

    // The tab layout is the default; the traditional rail is the opt-in.
    const defaults = await caller.users.getPreferences();
    expect(defaults.appearance.layout).toBe('deck');

    const updated = await caller.users.updatePreferences({
      appearance: { layout: 'classic' }
    });
    expect(updated.appearance.layout).toBe('classic');
    expect((await caller.users.getPreferences()).appearance.layout).toBe(
      'classic'
    );

    await expect(
      caller.users.updatePreferences({
        // @ts-expect-error -- unknown layout must be refused at the edge
        appearance: { layout: 'sideways' }
      })
    ).rejects.toThrow();
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

  test('the sent-message sound is off by default and its switch round-trips', async () => {
    const { caller } = await initTest();

    expect(DEFAULT_USER_PREFERENCES.soundNotification.messageSentSoundEnabled).toBe(false);
    expect((await caller.users.getPreferences()).soundNotification.messageSentSoundEnabled).toBe(false);

    const updated = await caller.users.updatePreferences({
      soundNotification: { messageSentSoundEnabled: true }
    });
    expect(updated.soundNotification.messageSentSoundEnabled).toBe(true);
    expect((await caller.users.getPreferences()).soundNotification.messageSentSoundEnabled).toBe(true);
  });

  test('the call ring switch and the chosen sound variants are stored, not stripped', async () => {
    const { caller } = await initTest();

    const updated = await caller.users.updatePreferences({
      soundNotification: {
        callSoundsEnabled: false,
        soundVariants: { MESSAGE_RECEIVED: 'soft', INCOMING_CALL: 'nocturne' }
      }
    });
    expect(updated.soundNotification).toMatchObject({
      callSoundsEnabled: false,
      soundVariants: { MESSAGE_RECEIVED: 'soft', INCOMING_CALL: 'nocturne' }
    });

    // Another key later leaves them in place.
    const after = await caller.users.updatePreferences({
      soundNotification: { masterVolume: 40 }
    });
    expect(after.soundNotification).toMatchObject({
      masterVolume: 40,
      callSoundsEnabled: false,
      soundVariants: { MESSAGE_RECEIVED: 'soft', INCOMING_CALL: 'nocturne' }
    });
    expect((await caller.users.getPreferences()).soundNotification).toEqual(after.soundNotification);

    // Bounded: the variant map and its keys.
    await expect(
      caller.users.updatePreferences({
        soundNotification: {
          soundVariants: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
        }
      })
    ).rejects.toThrow();
    await expect(
      caller.users.updatePreferences({
        soundNotification: { soundVariants: { MESSAGE_SENT: 'x'.repeat(65) } }
      })
    ).rejects.toThrow();
  });

  test('a sound settings row written before the flags existed reads with the defaults', async () => {
    const { caller } = await initTest();
    const legacy = {
      appearance: DEFAULT_USER_PREFERENCES.appearance,
      soundNotification: {
        masterVolume: 70,
        messageSoundsEnabled: true,
        voiceSoundsEnabled: false,
        actionSoundsEnabled: true,
        desktopNotificationsEnabled: false
      },
      theme: 'dark',
      serverChannelMap: {},
      rightSidebarOpen: false
    };
    await getTestDb()
      .insert(userPreferences)
      .values({ userId: 1, data: legacy as never, updatedAt: Date.now() });

    expect((await caller.users.getPreferences()).soundNotification).toEqual({
      ...legacy.soundNotification,
      callSoundsEnabled: true,
      messageSentSoundEnabled: false,
      soundVariants: {}
    });
    // An update fills them into the stored row as well.
    const updated = await caller.users.updatePreferences({ theme: 'onyx' });
    expect(updated.soundNotification).toMatchObject({
      voiceSoundsEnabled: false,
      callSoundsEnabled: true,
      messageSentSoundEnabled: false,
      soundVariants: {}
    });
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
