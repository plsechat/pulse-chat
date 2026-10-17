/**
 * Game presence: the desktop shell's report (users.setGamePresence),
 * the per-server sharing rule (preferences.presence) and what each
 * roster gets from it.
 *
 *  - set / clear: stored on the row; a same-name re-report keeps the
 *    original startedAt; null clears; the name is bounded.
 *  - the server is the authority on `shareGame`: a report while it is
 *    off stores nothing.
 *  - one report per 10 s per user (TOO_MANY_REQUESTS beyond).
 *  - fan-out: one USER_UPDATE per server the user is in, scoped by the
 *    server's publicId, carrying the presence where it may show and
 *    null where the user hid it; the roster route applies the same rule.
 *  - preference zod: bounded hidden list and key shape; flipping
 *    shareGame off clears the stored game and announces it.
 *  - a federated caller is refused (its home reports for it).
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */
import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createTestServerMember,
  insertMemberUser,
  insertOtherServer
} from '../../__tests__/fixtures';
import { seedPeerInstance } from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { servers, userPreferences, users } from '../../db/schema';
import { _resetGamePresenceRateLimitForTests } from '../../utils/game-presence';
import { pubsub } from '../../utils/pubsub';

type TUserUpdateEvent = {
  recipients: number[];
  payload: {
    id: number;
    gamePresence?: { name: string; startedAt: number } | null;
    scopeServerPublicId?: string;
  };
};

/** Collect USER_UPDATE fan-outs while `fn` runs; the real publish still happens. */
async function collectUserUpdates<T>(
  fn: () => Promise<T>
): Promise<{ result: T; events: TUserUpdateEvent[] }> {
  const events: TUserUpdateEvent[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (
    userIds: number | number[],
    topic: string,
    payload: unknown
  ) => {
    if (topic === ServerEvents.USER_UPDATE) {
      events.push({
        recipients: Array.isArray(userIds) ? userIds : [userIds],
        payload: payload as TUserUpdateEvent['payload']
      });
    }
    return original(userIds as never, topic as never, payload as never);
  };
  try {
    const result = await fn();
    return { result, events };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = original;
  }
}

const storedPresence = async (userId: number) => {
  const [row] = await getTestDb()
    .select({ gamePresence: users.gamePresence })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.gamePresence ?? null;
};

const serverPublicId = async (serverId: number) => {
  const [row] = await getTestDb()
    .select({ publicId: servers.publicId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return row!.publicId;
};

describe('users.setGamePresence', () => {
  test('stores the game, keeps startedAt on a same-name re-report, clears on null', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    await caller.users.updatePreferences({ presence: { shareGame: true } });

    const before = Date.now();
    const first = await caller.users.setGamePresence({ name: 'Rocket Pass' });
    expect(first.gamePresence?.name).toBe('Rocket Pass');
    expect(first.gamePresence!.startedAt).toBeGreaterThanOrEqual(before);

    // The shell re-sends on every reconnect; "for N min" must not restart.
    _resetGamePresenceRateLimitForTests();
    const again = await caller.users.setGamePresence({ name: 'Rocket Pass' });
    expect(again.gamePresence).toEqual(first.gamePresence);

    _resetGamePresenceRateLimitForTests();
    const other = await caller.users.setGamePresence({ name: '  Chess  ' });
    expect(other.gamePresence?.name).toBe('Chess');
    expect(other.gamePresence!.startedAt).toBeGreaterThanOrEqual(
      first.gamePresence!.startedAt
    );

    _resetGamePresenceRateLimitForTests();
    const cleared = await caller.users.setGamePresence(null);
    expect(cleared.gamePresence).toBeNull();
    expect(await storedPresence(1)).toBeNull();
  });

  test('bounds the name: empty and over 64 characters are rejected', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    await caller.users.updatePreferences({ presence: { shareGame: true } });

    await expect(caller.users.setGamePresence({ name: '   ' })).rejects.toThrow();
    await expect(
      caller.users.setGamePresence({ name: 'x'.repeat(65) })
    ).rejects.toThrow();
    expect(await storedPresence(1)).toBeNull();
  });

  test('a report while shareGame is off (the default) stores nothing', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();

    const { result, events } = await collectUserUpdates(() =>
      caller.users.setGamePresence({ name: 'Hidden Game' })
    );

    expect(result.gamePresence).toBeNull();
    expect(await storedPresence(1)).toBeNull();
    // Only the scoped (per-server) updates are this feature's; the
    // session bootstrap's own USER_UPDATE straggler is unscoped.
    expect(events.filter((e) => e.payload.scopeServerPublicId !== undefined)).toHaveLength(0);
  });

  test('is rate-limited to one report per 10 seconds per user', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    await caller.users.updatePreferences({ presence: { shareGame: true } });

    await caller.users.setGamePresence({ name: 'One' });
    await expect(
      caller.users.setGamePresence({ name: 'Two' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // The refused report did not land.
    expect((await storedPresence(1))?.name).toBe('One');

    // A refused report must not push the window out: the stamp is the
    // accepted one's, so the next admission is 10 s after "One".
    _resetGamePresenceRateLimitForTests();
    const second = await caller.users.setGamePresence({ name: 'Two' });
    expect(second.gamePresence?.name).toBe('Two');
  });

  test('fans out one scoped USER_UPDATE per server, null where the server is hidden', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    const other = await insertOtherServer();
    await createTestServerMember({ serverId: other.id, userId: 1 });
    const coMember = await insertMemberUser();
    const homePublicId = await serverPublicId(1);

    await caller.users.updatePreferences({
      presence: { shareGame: true, hiddenServers: [other.id] }
    });

    const { events } = await collectUserUpdates(() =>
      caller.users.setGamePresence({ name: 'Rocket Pass' })
    );

    const scoped = events.filter((e) => e.payload.scopeServerPublicId !== undefined);
    expect(scoped).toHaveLength(2);

    const home = scoped.find((e) => e.payload.scopeServerPublicId === homePublicId);
    expect(home).toBeDefined();
    expect(home!.payload.id).toBe(1);
    expect(home!.payload.gamePresence?.name).toBe('Rocket Pass');
    expect(home!.recipients).toContain(coMember.id);
    expect(home!.recipients).toContain(1);

    const hidden = scoped.find((e) => e.payload.scopeServerPublicId === other.publicId);
    expect(hidden).toBeDefined();
    expect(hidden!.payload.gamePresence).toBeNull();
    // Only that server's members hear about that server.
    expect(hidden!.recipients).not.toContain(coMember.id);

    // No unscoped update leaked the presence to everyone with a
    // presence interest.
    expect(
      events.filter(
        (e) => e.payload.scopeServerPublicId === undefined && 'gamePresence' in e.payload
      )
    ).toHaveLength(0);
  });

  test('the roster carries the presence only where it may show', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    const other = await insertOtherServer();
    await createTestServerMember({ serverId: other.id, userId: 1 });
    await caller.users.updatePreferences({
      presence: { shareGame: true, hiddenServers: [other.id] }
    });
    await caller.users.setGamePresence({ name: 'Rocket Pass' });

    const homeRoster = await caller.others.getServerMembers();
    const me = homeRoster.find((u) => u.id === 1);
    expect(me?.gamePresence?.name).toBe('Rocket Pass');
    // A member who is not playing says so explicitly (null, not absent):
    // the client must be able to tell "cleared" from "not said".
    const coMember = await insertMemberUser();
    const refreshed = await caller.others.getServerMembers();
    expect(refreshed.find((u) => u.id === coMember.id)?.gamePresence).toBeNull();

    // Switch to the hidden server: same user, nothing to show.
    const { caller: otherCaller } = await initTest();
    const { handshakeHash } = await otherCaller.others.handshake();
    await otherCaller.others.openSession({ handshakeHash, serverId: other.id });
    const otherRoster = await otherCaller.others.getServerMembers();
    expect(otherRoster.find((u) => u.id === 1)?.gamePresence).toBeNull();
  });

  test('a federated caller is refused — its home instance reports for it', async () => {
    _resetGamePresenceRateLimitForTests();
    await initTest();
    const instanceId = await seedPeerInstance('home.example');
    const [shadow] = await getTestDb()
      .insert(users)
      .values({
        name: 'ShadowReporter',
        supabaseId: 'shadow-game-presence-caller',
        publicId: 'shadow-pid-game-presence-caller',
        isFederated: true,
        federatedInstanceId: instanceId,
        federatedPublicId: 'remote-pid-game-presence-caller',
        createdAt: Date.now()
      })
      .returning({ id: users.id });
    await createTestServerMember({ serverId: 1, userId: shadow!.id });

    const { caller } = await initTest(shadow!.id);
    await expect(
      caller.users.setGamePresence({ name: 'Nope' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('preferences.presence', () => {
  test('defaults to off with no hidden servers, and reads back merged', async () => {
    const { caller } = await initTest();

    expect((await caller.users.getPreferences()).presence).toEqual({
      shareGame: false,
      hiddenServers: []
    });

    const updated = await caller.users.updatePreferences({
      presence: { hiddenServers: [1, 'peer.example:srv-abc'] }
    });
    expect(updated.presence).toEqual({
      shareGame: false,
      hiddenServers: [1, 'peer.example:srv-abc']
    });

    // A partial update keeps the other half.
    const flipped = await caller.users.updatePreferences({
      presence: { shareGame: true }
    });
    expect(flipped.presence.hiddenServers).toEqual([1, 'peer.example:srv-abc']);
    expect((await caller.users.getPreferences()).presence.shareGame).toBe(true);
  });

  test('a row written before the preference existed reads with the default', async () => {
    const { caller } = await initTest();
    const legacy = {
      appearance: { compactMode: true },
      soundNotification: {},
      theme: 'dark',
      serverChannelMap: {},
      rightSidebarOpen: false
    };
    await getTestDb()
      .insert(userPreferences)
      .values({ userId: 1, data: legacy as never, updatedAt: Date.now() });

    expect((await caller.users.getPreferences()).presence).toEqual({
      shareGame: false,
      hiddenServers: []
    });
    const merged = await caller.users.updatePreferences({ theme: 'nord' });
    expect(merged.presence).toEqual({ shareGame: false, hiddenServers: [] });
  });

  test('bounds the hidden list and each key', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.updatePreferences({
        presence: { hiddenServers: ['not a domain key'] }
      })
    ).rejects.toThrow();
    await expect(
      caller.users.updatePreferences({
        presence: { hiddenServers: [0] }
      })
    ).rejects.toThrow();
    await expect(
      caller.users.updatePreferences({
        presence: {
          hiddenServers: Array.from({ length: 201 }, (_, i) => i + 1)
        }
      })
    ).rejects.toThrow();
    await expect(
      caller.users.updatePreferences({
        presence: { hiddenServers: [`${'a'.repeat(320)}:srv`] }
      })
    ).rejects.toThrow();
  });

  test('turning shareGame off clears the stored game and announces it', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    await caller.users.updatePreferences({ presence: { shareGame: true } });
    await caller.users.setGamePresence({ name: 'Rocket Pass' });
    expect((await storedPresence(1))?.name).toBe('Rocket Pass');

    const { events } = await collectUserUpdates(() =>
      caller.users.updatePreferences({ presence: { shareGame: false } })
    );

    expect(await storedPresence(1)).toBeNull();
    const scoped = events.filter((e) => e.payload.scopeServerPublicId !== undefined);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.payload.gamePresence).toBeNull();
  });

  test('hiding a server re-announces: that roster clears, the others keep it', async () => {
    _resetGamePresenceRateLimitForTests();
    const { caller } = await initTest();
    const other = await insertOtherServer();
    await createTestServerMember({ serverId: other.id, userId: 1 });
    await caller.users.updatePreferences({ presence: { shareGame: true } });
    await caller.users.setGamePresence({ name: 'Rocket Pass' });

    const { events } = await collectUserUpdates(() =>
      caller.users.updatePreferences({
        presence: { hiddenServers: [other.id] }
      })
    );

    const byScope = new Map(
      events
        .filter((e) => e.payload.scopeServerPublicId !== undefined)
        .map((e) => [e.payload.scopeServerPublicId, e.payload.gamePresence])
    );
    expect(byScope.get(await serverPublicId(1))?.name).toBe('Rocket Pass');
    expect(byScope.get(other.publicId)).toBeNull();
    // The stored value itself is untouched — only visibility moved.
    expect((await storedPresence(1))?.name).toBe('Rocket Pass');
  });

  test('a preference change with nothing stored announces nothing', async () => {
    const { caller } = await initTest();

    const { events } = await collectUserUpdates(() =>
      caller.users.updatePreferences({ presence: { shareGame: true } })
    );

    expect(events.filter((e) => e.payload.scopeServerPublicId !== undefined)).toHaveLength(0);
  });
});
