/**
 * Game presence expiry, driven by its tick with an injected `now`: a
 * session that started more than 6 h ago is cleared and announced to
 * the user's rosters; a younger one and rows without a presence stay.
 * Also the last-socket clear: debounced, skipped when the user is back.
 *
 * Setup is inline per test (no beforeEach).
 */
import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { insertMemberUser } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { users } from '../../db/schema';
import {
  _setGamePresenceClearDebounceForTests,
  scheduleGamePresenceClear
} from '../../utils/game-presence';
import { pubsub } from '../../utils/pubsub';
import { expireGamePresenceTick } from '../game-presence';

const HOUR_MS = 60 * 60 * 1000;

const setStored = async (userId: number, presence: { name: string; startedAt: number } | null) =>
  getTestDb().update(users).set({ gamePresence: presence }).where(eq(users.id, userId));

const stored = async (userId: number) => {
  const [row] = await getTestDb()
    .select({ gamePresence: users.gamePresence })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.gamePresence ?? null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TScopedUpdate = { id: number; gamePresence?: unknown; scopeServerPublicId?: string };

/** USER_UPDATE payloads published while `fn` runs. */
async function collectUserUpdates<T>(fn: () => Promise<T>) {
  const payloads: TScopedUpdate[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (userIds: unknown, topic: string, payload: unknown) => {
    if (topic === ServerEvents.USER_UPDATE) payloads.push(payload as TScopedUpdate);
    return original(userIds as never, topic as never, payload as never);
  };
  try {
    const result = await fn();
    return { result, payloads };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = original;
  }
}

describe('expireGamePresenceTick', () => {
  test('clears sessions older than 6 h, announces them, keeps the rest', async () => {
    await initTest();
    const stale = await insertMemberUser();
    const fresh = await insertMemberUser();
    const idle = await insertMemberUser();
    const now = Date.now();
    await setStored(stale.id, { name: 'Old Game', startedAt: now - 7 * HOUR_MS });
    await setStored(fresh.id, { name: 'New Game', startedAt: now - 5 * HOUR_MS });
    await setStored(idle.id, null);

    const { result, payloads } = await collectUserUpdates(() =>
      expireGamePresenceTick(now)
    );

    expect(result).toBe(1);
    expect(await stored(stale.id)).toBeNull();
    expect((await stored(fresh.id))?.name).toBe('New Game');
    expect(await stored(idle.id)).toBeNull();

    // The cleared user's roster (server 1) hears null, scoped.
    const announced = payloads.filter((p) => p.id === stale.id);
    expect(announced).toHaveLength(1);
    expect(announced[0]!.gamePresence).toBeNull();
    expect(typeof announced[0]!.scopeServerPublicId).toBe('string');
    expect(payloads.some((p) => p.id === fresh.id)).toBe(false);
  });

  test('the boundary is exact: exactly 6 h old stays, a millisecond older goes', async () => {
    await initTest();
    const atBoundary = await insertMemberUser();
    const justOver = await insertMemberUser();
    const now = Date.now();
    await setStored(atBoundary.id, { name: 'Edge', startedAt: now - 6 * HOUR_MS });
    await setStored(justOver.id, { name: 'Over', startedAt: now - 6 * HOUR_MS - 1 });

    expect(await expireGamePresenceTick(now)).toBe(1);
    expect((await stored(atBoundary.id))?.name).toBe('Edge');
    expect(await stored(justOver.id)).toBeNull();
  });

  test('a tick with nothing stale is a no-op', async () => {
    await initTest();
    const { result, payloads } = await collectUserUpdates(() =>
      expireGamePresenceTick(Date.now())
    );
    expect(result).toBe(0);
    // The session bootstrap's own USER_UPDATE straggler is unscoped.
    expect(payloads.filter((p) => p.scopeServerPublicId !== undefined)).toHaveLength(0);
  });
});

describe('scheduleGamePresenceClear', () => {
  test('clears after the debounce when the user did not come back', async () => {
    await initTest();
    _setGamePresenceClearDebounceForTests(30);
    try {
      await setStored(1, { name: 'Rocket Pass', startedAt: Date.now() });

      const { payloads } = await collectUserUpdates(async () => {
        scheduleGamePresenceClear(1, () => false);
        await sleep(10);
        expect((await stored(1))?.name).toBe('Rocket Pass');
        await sleep(120);
      });

      expect(await stored(1)).toBeNull();
      expect(payloads.some((p) => p.id === 1 && p.gamePresence === null)).toBe(true);
    } finally {
      _setGamePresenceClearDebounceForTests(undefined);
    }
  });

  test('a user who is back inside the debounce keeps the game', async () => {
    await initTest();
    _setGamePresenceClearDebounceForTests(30);
    try {
      await setStored(1, { name: 'Rocket Pass', startedAt: Date.now() });

      const { payloads } = await collectUserUpdates(async () => {
        scheduleGamePresenceClear(1, () => true);
        await sleep(120);
      });

      expect((await stored(1))?.name).toBe('Rocket Pass');
      expect(payloads.filter((p) => p.scopeServerPublicId !== undefined)).toHaveLength(0);
    } finally {
      _setGamePresenceClearDebounceForTests(undefined);
    }
  });
});
