import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import {
  createTestChannel,
  createTestRole,
  grantTestUserRole
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { eventBus } from '../event-bus';

/**
 * The SDK 0.2 events as the USER routes emit them: a plugin listening
 * for reactions, threads and role changes must hear the ones people
 * cause, not only the ones plugins cause. Each test drives the real
 * tRPC route and asserts the bus payload.
 */

const SEEDED_MESSAGE_ID = 1;
const MEMBER_ROLE_ID = 2;

const collect = async (
  events: Parameters<typeof eventBus.on>[0][],
  run: () => Promise<unknown>
) => {
  const received: { event: string; payload: unknown }[] = [];
  const handlers = events.map((event) => {
    const handler = (payload: unknown) => {
      received.push({ event, payload });
    };
    eventBus.on(event, handler);
    return { event, handler };
  });
  try {
    await run();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const { event, handler } of handlers) eventBus.off(event, handler);
  }
  return received;
};

describe('message:reaction', () => {
  test('messages.toggleReaction emits added:true, then added:false, with the reactor', async () => {
    const { caller } = await initTest(1);

    const received = await collect(['message:reaction'], async () => {
      await caller.messages.toggleReaction({ messageId: SEEDED_MESSAGE_ID, emoji: '👍' });
      await caller.messages.toggleReaction({ messageId: SEEDED_MESSAGE_ID, emoji: '👍' });
    });

    expect(received).toEqual([
      {
        event: 'message:reaction',
        payload: { messageId: SEEDED_MESSAGE_ID, channelId: 1, userId: 1, emoji: '👍', added: true }
      },
      {
        event: 'message:reaction',
        payload: { messageId: SEEDED_MESSAGE_ID, channelId: 1, userId: 1, emoji: '👍', added: false }
      }
    ]);
  });
});

describe('thread:created', () => {
  test('threads.create emits with the parent message; threads.createForumPost without one', async () => {
    const { caller } = await initTest(1);
    const forumId = await createTestChannel({ serverId: 1, categoryId: 1, type: ChannelType.FORUM });

    const received = await collect(['thread:created'], async () => {
      const { threadId } = await caller.threads.create({ messageId: SEEDED_MESSAGE_ID, name: 'from message' });
      expect(threadId).toBeGreaterThan(0);
      await caller.threads.createForumPost({ channelId: forumId, title: 'A post', content: 'body' });
    });

    expect(received).toHaveLength(2);
    expect(received[0]!.payload).toEqual({
      threadId: expect.any(Number),
      parentChannelId: 1,
      serverId: 1,
      name: 'from message',
      creatorId: 1,
      parentMessageId: SEEDED_MESSAGE_ID
    });
    expect(received[1]!.payload).toEqual({
      threadId: expect.any(Number),
      parentChannelId: forumId,
      serverId: 1,
      name: 'A post',
      creatorId: 1
    });
    expect('pluginId' in (received[0]!.payload as object)).toBe(false);
  });
});

describe('member:roles_changed', () => {
  test('users.addRole and users.removeRole emit the full role set the member holds in that server', async () => {
    const { caller } = await initTest(1);
    const roleId = await createTestRole({ serverId: 1, name: 'Raider' });

    const received = await collect(['member:roles_changed'], async () => {
      await caller.users.addRole({ userId: 2, roleId });
      await caller.users.removeRole({ userId: 2, roleId });
    });

    expect(received).toEqual([
      { event: 'member:roles_changed', payload: { userId: 2, serverId: 1, roleIds: [MEMBER_ROLE_ID, roleId] } },
      { event: 'member:roles_changed', payload: { userId: 2, serverId: 1, roleIds: [MEMBER_ROLE_ID] } }
    ]);
  });

  test('deleting a role emits for every holder it fell back to the default role', async () => {
    const { caller } = await initTest(1);
    const roleId = await createTestRole({ serverId: 1, name: 'Temporary' });
    await grantTestUserRole(2, roleId);
    await grantTestUserRole(3, roleId);

    const received = await collect(['member:roles_changed'], () => caller.roles.delete({ roleId }));

    expect(received.map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        { userId: 2, serverId: 1, roleIds: [MEMBER_ROLE_ID] },
        { userId: 3, serverId: 1, roleIds: [MEMBER_ROLE_ID] }
      ])
    );
    expect(received).toHaveLength(2);
  });

  test('ownership transfer emits for both sides', async () => {
    const { caller } = await initTest(1);

    const received = await collect(['member:roles_changed'], () =>
      caller.servers.transferOwner({ serverId: 1, newOwnerId: 2 })
    );

    const byUser = Object.fromEntries(
      received.map((r) => [(r.payload as { userId: number }).userId, (r.payload as { roleIds: number[] }).roleIds])
    );
    expect(byUser[2]).toEqual(expect.arrayContaining([1]));
    expect(byUser[1]).not.toEqual(expect.arrayContaining([1]));
  });
});

describe('event:* names', () => {
  test('the bus accepts the scheduler event names with their payload and delivers them to listeners', async () => {
    const payload = {
      eventId: 1,
      serverId: 1,
      title: 'Raid',
      startsAt: 10,
      endsAt: 20,
      status: 'scheduled' as const
    };

    const received = await collect(
      ['event:created', 'event:updated', 'event:cancelled', 'event:started', 'event:ended'],
      async () => {
        await eventBus.emit('event:created', payload);
        await eventBus.emit('event:updated', { ...payload, title: 'Raid II' });
        await eventBus.emit('event:started', { ...payload, status: 'live' });
        await eventBus.emit('event:ended', { ...payload, status: 'done' });
        await eventBus.emit('event:cancelled', { ...payload, status: 'cancelled' });
      }
    );

    expect(received.map((r) => r.event)).toEqual([
      'event:created',
      'event:updated',
      'event:started',
      'event:ended',
      'event:cancelled'
    ]);
    expect(received[2]!.payload).toEqual({ ...payload, status: 'live' });
  });
});
