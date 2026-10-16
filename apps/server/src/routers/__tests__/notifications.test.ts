import { NotificationLevel, ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  createTestCategory,
  createTestChannel,
  createTestServer,
  createTestUser
} from '../../__tests__/fixtures';
import { getCaller, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channelReadStates, channels, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

const capturePublishes = () => {
  const published: { userIds: unknown; topic: string; payload: unknown }[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (userIds: unknown, topic: string, payload: unknown) => {
    published.push({ userIds, topic, payload });
    return original(userIds as never, topic as never, payload as never);
  };
  return {
    published,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }
  };
};

describe('notifications.markServerAsRead', () => {
  test('non-members are refused', async () => {
    const lonely = await createTestUser({ name: 'lonely' });
    const { caller } = await getCaller(lonely);
    const { handshakeHash } = await caller.others.handshake();
    await caller.others.joinServer({ handshakeHash });

    await expect(caller.notifications.markServerAsRead({ serverId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
  });

  test('marks only the channels the member can see and publishes for those', async () => {
    const tdb = getTestDb();
    const hidden = await createTestChannel({ serverId: 1, categoryId: 1, name: 'hidden' });
    await tdb.update(channels).set({ private: true }).where(eq(channels.id, hidden));
    await tdb.insert(messages).values({
      userId: 1,
      channelId: hidden,
      content: 'secret',
      metadata: null,
      createdAt: Date.now()
    });

    const { caller } = await initTest(2);
    const capture = capturePublishes();
    try {
      await caller.notifications.markServerAsRead({ serverId: 1 });
    } finally {
      capture.restore();
    }

    const rows = await tdb
      .select({ channelId: channelReadStates.channelId, last: channelReadStates.lastReadMessageId })
      .from(channelReadStates)
      .where(eq(channelReadStates.userId, 2));
    expect(rows.map((r) => r.channelId)).toEqual([1]);
    expect(rows[0]!.last).toBe(1);

    const readStateChannels = capture.published
      .filter((e) => e.topic === ServerEvents.CHANNEL_READ_STATES_UPDATE)
      .map((e) => (e.payload as { channelId: number }).channelId);
    expect(readStateChannels).toContain(1);
    expect(readStateChannels).not.toContain(hidden);
    expect(capture.published.some((e) => e.topic === ServerEvents.SERVER_UNREAD_COUNT_UPDATE)).toBe(true);

    // Second run upserts in place.
    await caller.notifications.markServerAsRead({ serverId: 1 });
    const again = await tdb
      .select({ channelId: channelReadStates.channelId })
      .from(channelReadStates)
      .where(eq(channelReadStates.userId, 2));
    expect(again.length).toBe(1);
  });
});

describe('notification settings', () => {
  test('per-channel level round-trips and is scoped to the active server', async () => {
    const { caller } = await initTest(2);

    expect((await caller.notifications.getSetting({ channelId: 1 })).level).toBe(NotificationLevel.DEFAULT);
    await caller.notifications.setSetting({ channelId: 1, level: 'mentions' });
    expect((await caller.notifications.getSetting({ channelId: 1 })).level).toBe(NotificationLevel.MENTIONS);
    await caller.notifications.setSetting({ channelId: 1, level: 'nothing' });
    expect((await caller.notifications.getSetting({ channelId: 1 })).level).toBe(NotificationLevel.NOTHING);

    const serverB = await createTestServer({ name: 'B', ownerId: 3 });
    const categoryB = await createTestCategory({ serverId: serverB });
    const channelB = await createTestChannel({ serverId: serverB, categoryId: categoryB });
    await expect(
      caller.notifications.setSetting({ channelId: channelB, level: 'all' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.notifications.getSetting({ channelId: channelB })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });

    const hidden = await createTestChannel({ serverId: 1, categoryId: 1, name: 'hidden' });
    await getTestDb().update(channels).set({ private: true }).where(eq(channels.id, hidden));
    await expect(
      caller.notifications.setSetting({ channelId: hidden, level: 'all' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('server mute and level are per member', async () => {
    const { caller } = await initTest(2);

    expect(await caller.notifications.getServerSettings({ serverId: 1 })).toEqual({
      muted: false,
      notificationLevel: 'default'
    });

    await caller.notifications.setServerMute({ serverId: 1, muted: true });
    await caller.notifications.setServerNotificationLevel({ serverId: 1, level: 'mentions' });

    expect(await caller.notifications.getServerSettings({ serverId: 1 })).toEqual({
      muted: true,
      notificationLevel: 'mentions'
    });

    const other = await initTest(3);
    expect(await other.caller.notifications.getServerSettings({ serverId: 1 })).toEqual({
      muted: false,
      notificationLevel: 'default'
    });

    const [row] = await getTestDb()
      .select({ muted: channelReadStates.userId })
      .from(channelReadStates)
      .where(and(eq(channelReadStates.userId, 2), eq(channelReadStates.channelId, 1)));
    expect(row).toBeUndefined();
  });
});
