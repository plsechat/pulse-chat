import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { pubsub } from '../../utils/pubsub';
import { ServerEvents } from '@pulse/shared';
import { getTestDb } from '../../__tests__/mock-db';
import { serverMembers } from '../../db/schema';

describe('nicknames', () => {
  test('should set own nickname', async () => {
    const { caller } = await initTest();

    await caller.users.setNickname({ nickname: 'MyNick' });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nickname: serverMembers.nickname })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, 1),
          eq(serverMembers.userId, 1)
        )
      )
      .limit(1);

    expect(row?.nickname).toBe('MyNick');
  });

  test('should clear own nickname by setting to null', async () => {
    const { caller } = await initTest();

    await caller.users.setNickname({ nickname: 'TempNick' });
    await caller.users.setNickname({ nickname: null });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nickname: serverMembers.nickname })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, 1),
          eq(serverMembers.userId, 1)
        )
      )
      .limit(1);

    expect(row?.nickname).toBeNull();
  });

  test('should reject nickname longer than 32 characters', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.setNickname({
        nickname: 'A'.repeat(33)
      })
    ).rejects.toThrow();
  });

  test('should set nickname for another user as admin', async () => {
    const { caller } = await initTest();

    await caller.users.setUserNickname({
      userId: 2,
      nickname: 'AdminSetNick'
    });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nickname: serverMembers.nickname })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, 1),
          eq(serverMembers.userId, 2)
        )
      )
      .limit(1);

    expect(row?.nickname).toBe('AdminSetNick');
  });

  test('should reject setUserNickname without MANAGE_USERS permission', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.setUserNickname({
        userId: 1,
        nickname: 'Hacker'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should include nickname in server members data', async () => {
    // First set a nickname as admin
    const { caller: adminCaller } = await initTest();
    await adminCaller.users.setNickname({ nickname: 'OwnerNick' });

    // Fetch members and check that nickname is present
    const { caller } = await initTest();
    const members = await caller.others.getServerMembers();
    const ownUser = members.find((u: { id: number }) => u.id === 1);

    expect(ownUser?.nickname).toBe('OwnerNick');
  });

  test('should trim whitespace from nickname', async () => {
    const { caller } = await initTest();

    await caller.users.setNickname({ nickname: '  Trimmed  ' });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nickname: serverMembers.nickname })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, 1),
          eq(serverMembers.userId, 1)
        )
      )
      .limit(1);

    expect(row?.nickname).toBe('Trimmed');
  });

  test('setNickname publishes USER_UPDATE to server members (incl. self)', async () => {
    const { caller } = await initTest();
    // Let initTest's fire-and-forget login publishers (status USER_UPDATE)
    // land before the spy installs, or they pollute the capture window.
    await new Promise((r) => setTimeout(r, 50));

    const published: { userIds: unknown; topic: string; payload: unknown }[] =
      [];
    const original = pubsub.publishFor.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = (
      userIds: unknown,
      topic: string,
      payload: unknown
    ) => {
      published.push({ userIds, topic, payload });
      return original(userIds as never, topic as never, payload as never);
    };

    try {
      await caller.users.setNickname({ nickname: 'LiveNick' });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }

    // Match on the payload too — concurrent presence publishers can still
    // race the window; the nickname event is the one under test.
    const updates = published.filter(
      (e) =>
        e.topic === ServerEvents.USER_UPDATE &&
        (e.payload as { nickname?: string | null }).nickname === 'LiveNick'
    );
    expect(updates.length).toBe(1);
    // The actor must be among recipients — the old plain publish() emitted
    // on a channel user subscriptions never listen on, so clients only saw
    // the change after a full refresh.
    expect(updates[0]!.userIds as number[]).toContain(1);
    expect(updates[0]!.payload).toMatchObject({ nickname: 'LiveNick' });
  });
});
