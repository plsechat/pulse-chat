import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
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

  test('should include nickname in initial join data', async () => {
    // First set a nickname as admin
    const { caller: adminCaller } = await initTest();
    await adminCaller.users.setNickname({ nickname: 'OwnerNick' });

    // Re-join and check that nickname is present in users list
    const { initialData } = await initTest();
    const ownUser = initialData.users.find((u) => u.id === 1);

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
});
