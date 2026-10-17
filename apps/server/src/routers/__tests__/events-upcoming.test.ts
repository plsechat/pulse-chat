import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createTestServer,
  createTestServerMember
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  events,
  federationInstances,
  userFederatedServers
} from '../../db/schema';

/**
 * events.upcomingForUser — the Home overview's "Upcoming events" list.
 * Scope is membership on THIS instance (server_members), the window and
 * the row count are bounded, only `scheduled` rows count, and the
 * caller's own roster standing rides along.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const roles = () => [
  { key: 'tank', label: 'Tank', cap: 1, color: '#60a5fa' },
  { key: 'dps', label: 'DPS', cap: 2, color: null }
];

/** A scheduled event row in `serverId` starting `startsIn` ms from now. */
const insertEvent = async (
  serverId: number,
  startsIn: number,
  overrides: Partial<typeof events.$inferInsert> = {}
) => {
  const startsAt = Date.now() + startsIn;
  const [row] = await getTestDb()
    .insert(events)
    .values({
      serverId,
      title: overrides.title ?? `Event ${startsIn}`,
      startsAt,
      endsAt: startsAt + HOUR_MS,
      hostId: null,
      roles: roles(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides
    })
    .returning();
  return row!;
};

describe('events.upcomingForUser', () => {
  test('lists only events of servers the caller is a member of', async () => {
    const { caller } = await initTest(2);
    const other = await createTestServer({ name: 'Elsewhere' });
    const mine = await insertEvent(1, 2 * HOUR_MS, { title: 'ours' });
    const foreign = await insertEvent(other, HOUR_MS, { title: 'theirs' });

    const before = await caller.events.upcomingForUser();
    expect(before.map((r) => r.event.id)).toEqual([mine.id]);
    expect(before[0]).toMatchObject({
      serverId: 1,
      serverName: expect.any(String),
      serverPublicId: expect.any(String),
      event: { id: mine.id, title: 'ours', status: 'scheduled' },
      mySignupStatus: null,
      mySignupRole: null
    });

    // Joining the other server brings its event in, soonest first.
    await createTestServerMember({ serverId: other, userId: 2 });
    const after = await caller.events.upcomingForUser();
    expect(after.map((r) => r.event.id)).toEqual([foreign.id, mine.id]);
    expect(after[0]!.serverName).toBe('Elsewhere');
  });

  test('a community joined on a federated peer contributes nothing', async () => {
    const { caller } = await initTest(2);
    const tdb = getTestDb();
    const [peer] = await tdb
      .insert(federationInstances)
      .values({
        domain: 'peer.example',
        name: 'peer.example',
        status: 'active',
        direction: 'outgoing',
        publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
        createdAt: Date.now()
      })
      .returning();
    // A local server the caller is NOT a member of, whose numeric id the
    // federated membership happens to name: the remote id space is not
    // ours, so the row must not be read as a local membership.
    const local = await createTestServer({ name: 'Local lookalike' });
    await tdb.insert(userFederatedServers).values({
      userId: 2,
      instanceId: peer!.id,
      remoteServerId: local,
      remoteServerPublicId: 'remote-pid',
      remoteServerName: 'Remote',
      joinedAt: Date.now()
    });
    await insertEvent(local, HOUR_MS, { title: 'remote-looking' });

    expect(await caller.events.upcomingForUser()).toEqual([]);
  });

  test('the window is now to withinHours ahead, a week by default', async () => {
    const { caller } = await initTest(1);
    await insertEvent(1, -HOUR_MS, { title: 'past' });
    const soon = await insertEvent(1, 30 * 60 * 1000, { title: 'soon' });
    const later = await insertEvent(1, 3 * DAY_MS, { title: 'later' });
    await insertEvent(1, 9 * DAY_MS, { title: 'next week' });

    const week = await caller.events.upcomingForUser();
    expect(week.map((r) => r.event.title)).toEqual(['soon', 'later']);
    expect(week.map((r) => r.event.id)).toEqual([soon.id, later.id]);

    const hour = await caller.events.upcomingForUser({ withinHours: 1 });
    expect(hour.map((r) => r.event.id)).toEqual([soon.id]);

    await expect(
      caller.events.upcomingForUser({ withinHours: 169 })
    ).rejects.toThrow();
  });

  test('limit caps the rows at the soonest ones and never exceeds ten', async () => {
    const { caller } = await initTest(1);
    const ids: number[] = [];
    for (let i = 1; i <= 4; i++) {
      ids.push((await insertEvent(1, i * HOUR_MS)).id);
    }

    const two = await caller.events.upcomingForUser({ limit: 2 });
    expect(two.map((r) => r.event.id)).toEqual(ids.slice(0, 2));

    expect((await caller.events.upcomingForUser({ limit: 10 })).length).toBe(4);
    await expect(caller.events.upcomingForUser({ limit: 11 })).rejects.toThrow();
    await expect(caller.events.upcomingForUser({ limit: 0 })).rejects.toThrow();
  });

  test('cancelled, live and finished events are left out', async () => {
    const { caller } = await initTest(1);
    const scheduled = await insertEvent(1, 2 * HOUR_MS, { title: 'on' });
    await insertEvent(1, HOUR_MS, { title: 'off', status: 'cancelled' });
    await insertEvent(1, HOUR_MS, { title: 'now', status: 'live' });
    await insertEvent(1, HOUR_MS, { title: 'over', status: 'done' });

    const rows = await caller.events.upcomingForUser();
    expect(rows.map((r) => r.event.id)).toEqual([scheduled.id]);

    // Cancelling the last one empties the list without a refetch of anything else.
    await getTestDb()
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, scheduled.id));
    expect(await caller.events.upcomingForUser()).toEqual([]);
  });

  test("carries the caller's own signup status and role label", async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const event = await insertEvent(1, 2 * HOUR_MS);

    await member.events.signup({ eventId: event.id, roleKey: 'tank' });
    const [asMember] = await member.events.upcomingForUser();
    expect(asMember).toMatchObject({
      mySignupStatus: 'confirmed',
      mySignupRole: 'Tank'
    });

    // Tank holds one: the owner lands on the bench, still with the label.
    await owner.events.signup({ eventId: event.id, roleKey: 'tank' });
    const [asOwner] = await owner.events.upcomingForUser();
    expect(asOwner).toMatchObject({ mySignupStatus: 'bench', mySignupRole: 'Tank' });

    await owner.events.decline({ eventId: event.id });
    const [declined] = await owner.events.upcomingForUser();
    expect(declined).toMatchObject({ mySignupStatus: 'declined', mySignupRole: null });
  });
});
