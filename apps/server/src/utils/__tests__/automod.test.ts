/**
 * utils/automod — the compiled-regex cache and the `timeout_user`
 * action: stamping the member's deadline, only ever extending it, and
 * the gate (assertNotTimedOut) that send/voice-join call.
 *
 * Setup is inline per test (no beforeEach) — see delete-account.test.ts.
 */
import { AutomodRuleType, Permission } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { automodRules, serverMembers } from '../../db/schema';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions,
  getAutomodRegexCompileCount,
  resetAutomodRegexCache
} from '../automod';

const insertRegexRule = async (pattern: string) => {
  const [rule] = await getTestDb()
    .insert(automodRules)
    .values({
      serverId: 1,
      name: `regex-${pattern}`,
      type: AutomodRuleType.KEYWORD_FILTER,
      config: { regexPatterns: [pattern] },
      actions: [{ type: 'log' }],
      createdBy: 1,
      createdAt: Date.now()
    })
    .returning();
  return rule!;
};

const timedOutUntilOf = async (userId: number) => {
  const [row] = await getTestDb()
    .select({ timedOutUntil: serverMembers.timedOutUntil })
    .from(serverMembers)
    .where(
      and(eq(serverMembers.serverId, 1), eq(serverMembers.userId, userId))
    );
  return row!.timedOutUntil;
};

const actionContext = {
  channelId: 1,
  userId: 2,
  content: 'offending',
  serverId: 1,
  ruleName: 'rule',
  authorId: 1
};

describe('automod regex cache', () => {
  test('a rule pattern is compiled once and reused across messages', async () => {
    resetAutomodRegexCache();
    await insertRegexRule('pine+apple');

    expect((await checkAutomod('I like pineapple', 1, 2, 1)).blocked).toBe(true);
    expect(getAutomodRegexCompileCount()).toBe(1);

    expect((await checkAutomod('pineeeapple again', 1, 2, 1)).blocked).toBe(true);
    expect((await checkAutomod('nothing here', 1, 2, 1)).blocked).toBe(false);
    expect(getAutomodRegexCompileCount()).toBe(1);
  });

  test('an edited pattern is a cache miss, so the new pattern applies', async () => {
    resetAutomodRegexCache();
    const rule = await insertRegexRule('pine+apple');

    expect((await checkAutomod('pineapple', 1, 2, 1)).blocked).toBe(true);
    expect(getAutomodRegexCompileCount()).toBe(1);

    await getTestDb()
      .update(automodRules)
      .set({ config: { regexPatterns: ['mang+o'] } })
      .where(eq(automodRules.id, rule.id));

    expect((await checkAutomod('pineapple', 1, 2, 1)).blocked).toBe(false);
    expect((await checkAutomod('mangooo', 1, 2, 1)).blocked).toBe(true);
    expect(getAutomodRegexCompileCount()).toBe(2);
  });
});

describe('timeout_user', () => {
  test('stamps the member deadline for the action duration (default 60s)', async () => {
    const before = Date.now();
    await executeAutomodActions(
      [{ type: 'timeout_user', duration: 300 }],
      actionContext
    );
    const until = await timedOutUntilOf(2);
    expect(until).toBeGreaterThanOrEqual(before + 300_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 300_000);

    await executeAutomodActions([{ type: 'timeout_user' }], {
      ...actionContext,
      userId: 3
    });
    const defaulted = await timedOutUntilOf(3);
    expect(defaulted).toBeGreaterThanOrEqual(before + 60_000);
    expect(defaulted).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test('a shorter follow-up never cuts an active timeout short', async () => {
    await executeAutomodActions(
      [{ type: 'timeout_user', duration: 600 }],
      actionContext
    );
    const long = await timedOutUntilOf(2);

    await executeAutomodActions(
      [{ type: 'timeout_user', duration: 10 }],
      actionContext
    );
    expect(await timedOutUntilOf(2)).toBe(long);

    await executeAutomodActions(
      [{ type: 'timeout_user', duration: 1200 }],
      actionContext
    );
    expect(await timedOutUntilOf(2)).toBeGreaterThan(long!);
  });

  test('assertNotTimedOut refuses with the remaining time, lifts on expiry, bypasses MANAGE_USERS', async () => {
    const tdb = getTestDb();
    const member = { userId: 2, hasPermission: async () => false };
    const moderator = {
      userId: 2,
      hasPermission: async (p: Permission | Permission[]) =>
        p === Permission.MANAGE_USERS
    };

    // Not timed out at all.
    await assertNotTimedOut(member, 1);

    await tdb
      .update(serverMembers)
      .set({ timedOutUntil: Date.now() + 90_000 })
      .where(and(eq(serverMembers.serverId, 1), eq(serverMembers.userId, 2)));

    await expect(assertNotTimedOut(member, 1)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/timed out .* \d+ seconds/)
    });
    await assertNotTimedOut(moderator, 1);

    // Another server's membership is unaffected (no row there → 0).
    await assertNotTimedOut(member, 999);

    await tdb
      .update(serverMembers)
      .set({ timedOutUntil: Date.now() - 1 })
      .where(and(eq(serverMembers.serverId, 1), eq(serverMembers.userId, 2)));
    await assertNotTimedOut(member, 1);
  });
});
