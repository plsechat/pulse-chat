import { ChannelType, ServerEvents } from '@pulse/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  insertOtherServer,
  insertVoiceChannel
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  channels,
  eventRosterTemplates,
  eventSignups,
  events,
  messages,
  servers
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type PublishCall = [number | number[], string, unknown];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

/**
 * Publishers are fire-and-forget (they resolve the member list first),
 * so a route returns before its fan-out lands on the spy. Poll briefly.
 */
const publishedCalls = async (
  spy: { mock: { calls: unknown[][] } },
  topic: string,
  count = 1
) => {
  for (let i = 0; i < 200 && callsFor(spy, topic).length < count; i++) {
    await Bun.sleep(5);
  }
  return callsFor(spy, topic);
};

const roles = (overrides?: Partial<Record<'tank' | 'healer' | 'dps', number | null>>) => [
  { key: 'tank', label: 'Tank', cap: overrides?.tank ?? 1, color: '#60a5fa' },
  { key: 'healer', label: 'Healer', cap: overrides?.healer ?? 1, color: '#5ee29a' },
  { key: 'dps', label: 'DPS', cap: overrides?.dps ?? 2, color: null }
];

/** A valid create input two days out; override what the test cares about. */
const draft = (overrides: Record<string, unknown> = {}) => {
  const startsAt = Date.now() + 48 * HOUR_MS;
  return {
    title: 'Raid night',
    startsAt,
    endsAt: startsAt + 2 * HOUR_MS,
    roles: roles(),
    ...overrides
  };
};

const signupRows = (eventId: number) =>
  getTestDb()
    .select()
    .from(eventSignups)
    .where(eq(eventSignups.eventId, eventId))
    .orderBy(eventSignups.position);

const signupOf = async (eventId: number, userId: number) =>
  (await signupRows(eventId)).find((row) => row.userId === userId);

describe('events router', () => {
  describe('authorization', () => {
    test('create needs MANAGE_EVENTS; update/cancel need the host or MANAGE_EVENTS', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);

      await expect(member.events.create(draft())).rejects.toThrow(
        'Insufficient permissions'
      );

      const event = await owner.events.create(draft());
      expect(event.hostId).toBe(1);
      expect(event.status).toBe('scheduled');

      await expect(
        member.events.update({ eventId: event.id, title: 'hijack' })
      ).rejects.toThrow('Only the host or an events manager');
      await expect(member.events.cancel({ eventId: event.id })).rejects.toThrow(
        'Only the host or an events manager'
      );

      // The host edits their own event without the server permission.
      await getTestDb()
        .update(events)
        .set({ hostId: 2 })
        .where(eq(events.id, event.id));
      const updated = await member.events.update({
        eventId: event.id,
        title: 'Host edit'
      });
      expect(updated.title).toBe('Host edit');
      await member.events.cancel({ eventId: event.id });
      expect((await owner.events.get({ eventId: event.id })).event.status).toBe(
        'cancelled'
      );
    });

    test('every by-id route treats another server\'s event as not found', async () => {
      const tdb = getTestDb();
      const { caller } = await initTest(1);
      const other = await insertOtherServer();
      const startsAt = Date.now() + HOUR_MS;

      const [foreign] = await tdb
        .insert(events)
        .values({
          serverId: other.id,
          title: 'foreign',
          startsAt,
          endsAt: startsAt + HOUR_MS,
          hostId: null,
          roles: roles(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        .returning();

      const eventId = foreign!.id;
      await expect(caller.events.get({ eventId })).rejects.toThrow('Event not found');
      await expect(caller.events.update({ eventId, title: 'x' })).rejects.toThrow(
        'Event not found'
      );
      await expect(caller.events.cancel({ eventId })).rejects.toThrow('Event not found');
      await expect(caller.events.signup({ eventId, roleKey: 'tank' })).rejects.toThrow(
        'Event not found'
      );
      await expect(caller.events.decline({ eventId })).rejects.toThrow('Event not found');
      await expect(caller.events.withdraw({ eventId })).rejects.toThrow(
        'Event not found'
      );
      await expect(
        caller.events.setSignupStatus({ eventId, userId: 2, status: 'bench' })
      ).rejects.toThrow('Event not found');

      expect(await caller.events.list({ from: startsAt - HOUR_MS, to: startsAt + HOUR_MS })).toEqual([]);

      const [still] = await tdb.select().from(events).where(eq(events.id, eventId));
      expect(still!.title).toBe('foreign');
      expect(still!.status).toBe('scheduled');
    });

    test('a template or announce channel of another server is not found', async () => {
      const tdb = getTestDb();
      const { caller } = await initTest(1);
      const other = await insertOtherServer();
      const [foreignTemplate] = await tdb
        .insert(eventRosterTemplates)
        .values({ serverId: other.id, name: 'foreign', roles: roles(), createdAt: Date.now() })
        .returning();
      const foreignChannel = await createTestChannel({ serverId: other.id });

      await expect(
        caller.events.create({ ...draft(), roles: undefined, templateId: foreignTemplate!.id })
      ).rejects.toThrow('Template not found');
      await expect(
        caller.events.create(draft({ announceChannelId: foreignChannel }))
      ).rejects.toThrow('Channel not found');
    });

    test('the announce channel must be a text channel the caller can view', async () => {
      const { caller } = await initTest(1);
      const voice = await insertVoiceChannel();

      await expect(
        caller.events.create(draft({ announceChannelId: voice.id }))
      ).rejects.toThrow('Channel not found');

      const privateChannel = await createTestChannel({ serverId: 1, name: 'secret' });
      await getTestDb()
        .update(channels)
        .set({ private: true })
        .where(eq(channels.id, privateChannel));
      // Owner bypasses channel permissions: still a valid target for them.
      const event = await caller.events.create(draft({ announceChannelId: privateChannel }));
      expect(event.announceChannelId).toBe(privateChannel);
    });
  });

  describe('create', () => {
    test('bounds every field', async () => {
      const { caller } = await initTest(1);
      const base = draft();

      await expect(caller.events.create({ ...base, title: 'x'.repeat(121) })).rejects.toThrow();
      await expect(caller.events.create({ ...base, description: 'x'.repeat(2001) })).rejects.toThrow();
      await expect(caller.events.create({ ...base, gameTag: 'x'.repeat(41) })).rejects.toThrow();
      await expect(caller.events.create({ ...base, endsAt: base.startsAt })).rejects.toThrow(
        'must end after it starts'
      );
      await expect(
        caller.events.create({ ...base, endsAt: base.startsAt + 25 * HOUR_MS })
      ).rejects.toThrow('at most 24 hours');
      await expect(
        caller.events.create({
          ...base,
          startsAt: Date.now() - 10 * MINUTE_MS,
          endsAt: Date.now() + HOUR_MS
        })
      ).rejects.toThrow('cannot start in the past');
      await expect(caller.events.create({ ...base, maxParticipants: 0 })).rejects.toThrow();
      await expect(caller.events.create({ ...base, maxParticipants: 501 })).rejects.toThrow();
      await expect(
        caller.events.create({
          ...base,
          roles: Array.from({ length: 13 }, (_, i) => ({
            key: `r${i}`,
            label: `R${i}`,
            cap: null,
            color: null
          }))
        })
      ).rejects.toThrow();
      await expect(
        caller.events.create({
          ...base,
          roles: [
            { key: 'tank', label: 'A', cap: 1, color: null },
            { key: 'tank', label: 'B', cap: 1, color: null }
          ]
        })
      ).rejects.toThrow('unique');
      await expect(
        caller.events.create({
          ...base,
          roles: [{ key: 'tank', label: 'A', cap: 201, color: '#ff0000' }]
        })
      ).rejects.toThrow();
      await expect(
        caller.events.create({
          ...base,
          roles: [{ key: 'tank', label: 'A', cap: 1, color: 'red' }]
        })
      ).rejects.toThrow();
      await expect(caller.events.create({ ...base, roles: undefined })).rejects.toThrow(
        'Pick a roster template or define roles'
      );

      // A "starts now" event typed a moment ago is fine.
      const soon = await caller.events.create({
        ...base,
        startsAt: Date.now() - MINUTE_MS,
        endsAt: Date.now() + HOUR_MS
      });
      expect(soon.status).toBe('scheduled');
    });

    test('snapshots the template roles and survives template edits and deletion', async () => {
      const { caller } = await initTest(1);
      const template = await caller.events.templates.create({
        name: 'Ten man',
        roles: roles({ dps: 6 })
      });

      const event = await caller.events.create({
        ...draft(),
        roles: undefined,
        templateId: template.id
      });
      expect(event.templateId).toBe(template.id);
      expect(event.roles).toEqual(roles({ dps: 6 }));

      await caller.events.templates.update({
        templateId: template.id,
        roles: roles({ dps: 20 })
      });
      await caller.events.templates.delete({ templateId: template.id });

      const { event: after } = await caller.events.get({ eventId: event.id });
      expect(after.roles).toEqual(roles({ dps: 6 }));
      expect(after.templateId).toBeNull();
    });

    test('posts the RSVP card as a system row in the announce channel and fans out EVENT_CREATE', async () => {
      const { caller } = await initTest(1);
      const channel = await createEmptyTextChannel('raids');
      const spy = spyOn(pubsub, 'publishFor');

      try {
        const event = await caller.events.create(
          draft({ announceChannelId: channel.id, description: 'Bring flasks' })
        );

        const rows = await getTestDb()
          .select()
          .from(messages)
          .where(eq(messages.channelId, channel.id));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.type).toBe('system');
        expect(rows[0]!.editable).toBe(false);
        expect(rows[0]!.userId).toBe(1);
        expect(JSON.parse(rows[0]!.content!)).toEqual({ kind: 'event', eventId: event.id });

        const created = await publishedCalls(spy, ServerEvents.EVENT_CREATE);
        expect(created).toHaveLength(1);
        expect([...(created[0]![0] as number[])].sort()).toEqual([1, 2, 3]);
        expect((created[0]![2] as { id: number }).id).toBe(event.id);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('update', () => {
    test('removing a role benches its confirmed signups and keeps the rest', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(draft());

      await member.events.signup({ eventId: event.id, roleKey: 'healer' });
      await third.events.signup({ eventId: event.id, roleKey: 'tank' });

      const updated = await owner.events.update({
        eventId: event.id,
        roles: [{ key: 'tank', label: 'Tank', cap: 2, color: null }]
      });
      expect(updated.roles.map((r) => r.key)).toEqual(['tank']);

      const benched = await signupOf(event.id, 2);
      expect(benched!.status).toBe('bench');
      expect(benched!.roleKey).toBe('healer');
      const kept = await signupOf(event.id, 3);
      expect(kept!.status).toBe('confirmed');

      const detail = await owner.events.get({ eventId: event.id });
      expect(detail.roster.bench.map((s) => s.userId)).toEqual([2]);
      expect(detail.roster.confirmed[0]!.signups.map((s) => s.userId)).toEqual([3]);
    });

    test('moving the start re-arms only the reminders still ahead', async () => {
      const { caller } = await initTest(1);
      const event = await caller.events.create(draft());
      expect(event.reminderStage).toBe(0);

      // 30 minutes out: the 24 h and 1 h moments are already behind.
      const soon = await caller.events.update({
        eventId: event.id,
        startsAt: Date.now() + 30 * MINUTE_MS,
        endsAt: Date.now() + 90 * MINUTE_MS
      });
      expect(soon.reminderStage).toBe(2);

      // Three days out again: everything is ahead.
      const later = await caller.events.update({
        eventId: event.id,
        startsAt: Date.now() + 72 * HOUR_MS,
        endsAt: Date.now() + 74 * HOUR_MS
      });
      expect(later.reminderStage).toBe(0);

      // Untouched start: the stage is left alone.
      await getTestDb()
        .update(events)
        .set({ reminderStage: 1 })
        .where(eq(events.id, event.id));
      const renamed = await caller.events.update({ eventId: event.id, title: 'Renamed' });
      expect(renamed.reminderStage).toBe(1);
    });

    test('a live event accepts edits but a closed one does not; the window rules still apply', async () => {
      const { caller } = await initTest(1);
      const event = await caller.events.create(draft());

      await expect(
        caller.events.update({ eventId: event.id, endsAt: event.startsAt })
      ).rejects.toThrow('must end after it starts');

      await getTestDb().update(events).set({ status: 'live' }).where(eq(events.id, event.id));
      const live = await caller.events.update({ eventId: event.id, description: 'Go go' });
      expect(live.description).toBe('Go go');

      await getTestDb().update(events).set({ status: 'done' }).where(eq(events.id, event.id));
      await expect(
        caller.events.update({ eventId: event.id, description: 'late' })
      ).rejects.toThrow('closed');
    });

    test('moving the start into the past is refused; an unchanged past start stays editable', async () => {
      const { caller } = await initTest(1);
      const event = await caller.events.create(draft());

      await expect(
        caller.events.update({
          eventId: event.id,
          startsAt: Date.now() - 10 * MINUTE_MS,
          endsAt: Date.now() + HOUR_MS
        })
      ).rejects.toThrow('cannot start in the past');
      // Only the start is checked: the end alone may move while the
      // start stays where it was.
      const stretched = await caller.events.update({
        eventId: event.id,
        endsAt: event.startsAt + 3 * HOUR_MS
      });
      expect(stretched.endsAt).toBe(event.startsAt + 3 * HOUR_MS);

      // A live event started an hour ago: its start is in the past by
      // nature, and edits that leave it alone must still go through.
      const startedAt = Date.now() - HOUR_MS;
      await getTestDb()
        .update(events)
        .set({ status: 'live', startsAt: startedAt, endsAt: startedAt + 3 * HOUR_MS })
        .where(eq(events.id, event.id));
      const live = await caller.events.update({
        eventId: event.id,
        title: 'Still on',
        startsAt: startedAt,
        endsAt: startedAt + 4 * HOUR_MS
      });
      expect(live.title).toBe('Still on');
      expect(live.startsAt).toBe(startedAt);
      // … but pushing that start further back is a change into the past.
      await expect(
        caller.events.update({
          eventId: event.id,
          startsAt: startedAt - HOUR_MS,
          endsAt: startedAt + 3 * HOUR_MS
        })
      ).rejects.toThrow('cannot start in the past');
    });
  });

  describe('planner switch', () => {
    const setPlanner = (serverId: number, on: boolean) =>
      getTestDb().update(servers).set({ enableEvents: on }).where(eq(servers.id, serverId));

    test('every route refuses while the community has the Planner off; the events come back unchanged', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const event = await owner.events.create(draft());
      await member.events.signup({ eventId: event.id, roleKey: 'tank' });
      const template = await owner.events.templates.create({ name: 'Ten man', roles: roles() });

      await setPlanner(1, false);

      const off = 'The Planner is turned off in this community';
      const window = { from: event.startsAt - HOUR_MS, to: event.startsAt + HOUR_MS };
      await expect(owner.events.create(draft())).rejects.toThrow(off);
      await expect(owner.events.update({ eventId: event.id, title: 'x' })).rejects.toThrow(off);
      await expect(owner.events.cancel({ eventId: event.id })).rejects.toThrow(off);
      await expect(member.events.list(window)).rejects.toThrow(off);
      await expect(member.events.get({ eventId: event.id })).rejects.toThrow(off);
      await expect(member.events.signup({ eventId: event.id, roleKey: 'dps' })).rejects.toThrow(off);
      await expect(member.events.decline({ eventId: event.id })).rejects.toThrow(off);
      await expect(member.events.withdraw({ eventId: event.id })).rejects.toThrow(off);
      await expect(
        owner.events.setSignupStatus({ eventId: event.id, userId: 2, status: 'bench' })
      ).rejects.toThrow(off);
      await expect(member.events.getCalendarUrl()).rejects.toThrow(off);
      await expect(member.events.templates.list()).rejects.toThrow(off);
      await expect(owner.events.templates.create({ name: 'No', roles: roles() })).rejects.toThrow(off);
      await expect(
        owner.events.templates.update({ templateId: template.id, name: 'No' })
      ).rejects.toThrow(off);
      await expect(owner.events.templates.delete({ templateId: template.id })).rejects.toThrow(off);

      // Nothing was cancelled or touched: the rows wait for the switch.
      const [row] = await getTestDb().select().from(events).where(eq(events.id, event.id));
      expect(row!.status).toBe('scheduled');
      expect((await signupOf(event.id, 2))!.status).toBe('confirmed');

      await setPlanner(1, true);

      const listed = await member.events.list(window);
      expect(listed.map((e) => e.id)).toEqual([event.id]);
      expect(listed[0]!.ownSignup).toEqual({ roleKey: 'tank', status: 'confirmed', position: 1 });
      expect((await member.events.templates.list()).map((t) => t.id)).toEqual([template.id]);
      const renamed = await owner.events.update({ eventId: event.id, title: 'Back on' });
      expect(renamed.title).toBe('Back on');
    });

    test('the switch is per community: another server stays on', async () => {
      const { caller } = await initTest(1);
      const other = await insertOtherServer();
      await setPlanner(other.id, false);

      const event = await caller.events.create(draft());
      expect((await caller.events.get({ eventId: event.id })).event.id).toBe(event.id);
    });
  });

  describe('cancel', () => {
    test('removes the voice room at once and publishes the cancelled state', async () => {
      const tdb = getTestDb();
      const { caller } = await initTest(1);
      const event = await caller.events.create(draft());
      const room = await insertVoiceChannel();
      await tdb.update(events).set({ voiceChannelId: room.id }).where(eq(events.id, event.id));

      const spy = spyOn(pubsub, 'publishFor');
      try {
        await caller.events.cancel({ eventId: event.id });

        const updates = await publishedCalls(spy, ServerEvents.EVENT_UPDATE);
        expect(updates).toHaveLength(1);
        expect(updates[0]![2]).toMatchObject({
          id: event.id,
          serverId: 1,
          status: 'cancelled',
          voiceChannelId: null
        });
        expect((await publishedCalls(spy, ServerEvents.CHANNEL_DELETE)).map((c) => c[2])).toContain(room.id);
      } finally {
        spy.mockRestore();
      }

      expect(await tdb.select().from(channels).where(eq(channels.id, room.id))).toHaveLength(0);
      const [row] = await tdb.select().from(events).where(eq(events.id, event.id));
      expect(row!.status).toBe('cancelled');
      expect(row!.voiceChannelId).toBeNull();

      await expect(caller.events.cancel({ eventId: event.id })).rejects.toThrow('already closed');
      await expect(
        caller.events.signup({ eventId: event.id, roleKey: 'tank' })
      ).rejects.toThrow('closed');
    });
  });

  describe('list', () => {
    test('returns the window with roster counts and the caller\'s own signup', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const now = Date.now();
      const near = await owner.events.create(
        draft({ startsAt: now + 2 * HOUR_MS, endsAt: now + 3 * HOUR_MS })
      );
      await owner.events.create(
        draft({ title: 'Far', startsAt: now + 40 * 24 * HOUR_MS, endsAt: now + 41 * 24 * HOUR_MS })
      );

      await member.events.signup({ eventId: near.id, roleKey: 'tank' });
      await owner.events.signup({ eventId: near.id, roleKey: 'tank' });

      const listed = await member.events.list({ from: now, to: now + 10 * 24 * HOUR_MS });
      expect(listed.map((e) => e.id)).toEqual([near.id]);
      expect(listed[0]!.counts).toEqual({
        byRole: {
          tank: { confirmed: 1, bench: 1 },
          healer: { confirmed: 0, bench: 0 },
          dps: { confirmed: 0, bench: 0 }
        },
        confirmed: 1,
        bench: 1,
        declined: 0
      });
      expect(listed[0]!.ownSignup).toEqual({ roleKey: 'tank', status: 'confirmed', position: 1 });

      const asOwner = await owner.events.list({ from: now, to: now + 10 * 24 * HOUR_MS });
      expect(asOwner[0]!.ownSignup?.status).toBe('bench');

      const wide = await owner.events.list({ from: now, to: now + 60 * 24 * HOUR_MS });
      expect(wide).toHaveLength(2);

      await expect(
        owner.events.list({ from: now, to: now + 63 * 24 * HOUR_MS })
      ).rejects.toThrow('62 days');
      await expect(owner.events.list({ from: now, to: now - 1 })).rejects.toThrow(
        'ends before it starts'
      );
    });

    test('defaults to the current month', async () => {
      const { caller } = await initTest(1);
      const now = new Date();
      // A slot inside this month, at least five minutes ahead when the
      // test runs on the last minute of the month.
      const endOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1;
      const startsAt = Math.min(Date.now() + HOUR_MS, endOfMonth - 10 * MINUTE_MS);
      const inMonth = await caller.events.create(
        draft({ startsAt, endsAt: startsAt + 5 * MINUTE_MS })
      );
      await caller.events.create(
        draft({ startsAt: endOfMonth + 48 * HOUR_MS, endsAt: endOfMonth + 49 * HOUR_MS })
      );

      const listed = await caller.events.list();
      expect(listed.map((e) => e.id)).toEqual([inMonth.id]);
    });
  });

  describe('signups', () => {
    test('caps fill in order, the bench keeps arrival order and withdraw auto-promotes', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(draft());

      const first = await owner.events.signup({ eventId: event.id, roleKey: 'tank' });
      expect(first.signup.status).toBe('confirmed');
      const second = await member.events.signup({ eventId: event.id, roleKey: 'tank' });
      expect(second.signup.status).toBe('bench');
      const thirdUp = await third.events.signup({ eventId: event.id, roleKey: 'tank' });
      expect(thirdUp.signup.status).toBe('bench');
      expect(thirdUp.signup.position).toBeGreaterThan(second.signup.position);

      let detail = await owner.events.get({ eventId: event.id });
      expect(detail.roster.bench.map((s) => s.userId)).toEqual([2, 3]);
      expect(detail.roster.confirmed.map((g) => [g.role.key, g.signups.map((s) => s.userId)])).toEqual([
        ['tank', [1]],
        ['healer', []],
        ['dps', []]
      ]);
      expect(detail.host).toEqual({ id: 1, name: 'Test Owner', avatar: null });

      await expect(
        owner.events.signup({ eventId: event.id, roleKey: 'nope' })
      ).rejects.toThrow('Unknown role');

      const spy = spyOn(pubsub, 'publishFor');
      try {
        const withdrawn = await owner.events.withdraw({ eventId: event.id });
        expect(withdrawn.promotedUserId).toBe(2);

        const updates = await publishedCalls(spy, ServerEvents.EVENT_SIGNUPS_UPDATE);
        expect(updates).toHaveLength(1);
        expect((updates[0]![2] as { counts: { byRole: Record<string, unknown> } }).counts.byRole.tank).toEqual({
          confirmed: 1,
          bench: 1
        });
      } finally {
        spy.mockRestore();
      }

      detail = await owner.events.get({ eventId: event.id });
      expect(detail.roster.confirmed[0]!.signups.map((s) => s.userId)).toEqual([2]);
      expect(detail.roster.bench.map((s) => s.userId)).toEqual([3]);
      expect(await signupOf(event.id, 1)).toBeUndefined();

      // Withdrawing without a signup is a no-op.
      expect(await owner.events.withdraw({ eventId: event.id })).toEqual({ promotedUserId: null });
    });

    test('decline frees the slot for the first benched member and counts as declined', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(draft());

      await member.events.signup({ eventId: event.id, roleKey: 'healer' });
      await third.events.signup({ eventId: event.id, roleKey: 'healer' });

      const declined = await member.events.decline({ eventId: event.id });
      expect(declined.signup.status).toBe('declined');
      expect(declined.promotedUserId).toBe(3);

      const detail = await owner.events.get({ eventId: event.id });
      expect(detail.roster.declined).toBe(1);
      expect(detail.counts.byRole.healer).toEqual({ confirmed: 1, bench: 0 });

      // A decline with no prior signup is an RSVP of its own.
      const cold = await owner.events.decline({ eventId: event.id });
      expect(cold.signup.status).toBe('declined');
      expect((await owner.events.get({ eventId: event.id })).roster.declined).toBe(2);

      // Signing up again after declining re-enters the roster.
      const back = await member.events.signup({ eventId: event.id, roleKey: 'tank' });
      expect(back.signup.status).toBe('confirmed');
    });

    test('maxParticipants benches even when the role has room', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const event = await owner.events.create(
        draft({ maxParticipants: 1, roles: roles({ tank: 5 }) })
      );

      expect((await owner.events.signup({ eventId: event.id, roleKey: 'tank' })).signup.status).toBe(
        'confirmed'
      );
      expect((await member.events.signup({ eventId: event.id, roleKey: 'tank' })).signup.status).toBe(
        'bench'
      );

      await owner.events.withdraw({ eventId: event.id });
      expect((await signupOf(event.id, 2))!.status).toBe('confirmed');
    });

    test('re-signing with another role moves the signup and frees the old slot', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(draft());

      await member.events.signup({ eventId: event.id, roleKey: 'tank' });
      await third.events.signup({ eventId: event.id, roleKey: 'tank' });

      const moved = await member.events.signup({ eventId: event.id, roleKey: 'healer' });
      expect(moved.signup.roleKey).toBe('healer');
      expect(moved.signup.status).toBe('confirmed');
      expect(moved.promotedUserId).toBe(3);
      expect((await signupOf(event.id, 3))!.status).toBe('confirmed');

      // Same role again: nothing moves, the position is kept.
      const again = await member.events.signup({ eventId: event.id, roleKey: 'healer' });
      expect(again.signup.position).toBe(moved.signup.position);
      expect(again.promotedUserId).toBeNull();

      expect(await signupRows(event.id)).toHaveLength(2);
    });

    test('an unlimited role never benches', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(
        draft({ roles: [{ key: 'flex', label: 'Flex', cap: null, color: '#ffb454' }] })
      );

      for (const c of [owner, member, third]) {
        expect((await c.events.signup({ eventId: event.id, roleKey: 'flex' })).signup.status).toBe(
          'confirmed'
        );
      }
    });
  });

  describe('setSignupStatus', () => {
    test('host promotion honours caps; benching is manual and does not auto-promote', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const { caller: third } = await initTest(3);
      const event = await owner.events.create(draft());

      await member.events.signup({ eventId: event.id, roleKey: 'tank' });
      await third.events.signup({ eventId: event.id, roleKey: 'tank' });

      await expect(
        owner.events.setSignupStatus({ eventId: event.id, userId: 3, status: 'confirmed' })
      ).rejects.toThrow('That role is full');

      const benched = await owner.events.setSignupStatus({
        eventId: event.id,
        userId: 2,
        status: 'bench'
      });
      expect(benched.status).toBe('bench');
      expect((await signupOf(event.id, 3))!.status).toBe('bench');

      const promoted = await owner.events.setSignupStatus({
        eventId: event.id,
        userId: 3,
        status: 'confirmed'
      });
      expect(promoted.status).toBe('confirmed');

      // Promotion into another role with room.
      const moved = await owner.events.setSignupStatus({
        eventId: event.id,
        userId: 2,
        status: 'confirmed',
        roleKey: 'healer'
      });
      expect(moved.roleKey).toBe('healer');
      expect(moved.status).toBe('confirmed');

      await expect(
        owner.events.setSignupStatus({ eventId: event.id, userId: 2, status: 'bench', roleKey: 'nope' })
      ).rejects.toThrow('Unknown role');
      await expect(
        owner.events.setSignupStatus({ eventId: event.id, userId: 999, status: 'bench' })
      ).rejects.toThrow('Signup not found');
      await expect(
        third.events.setSignupStatus({ eventId: event.id, userId: 2, status: 'bench' })
      ).rejects.toThrow('Only the host or an events manager');
    });

    test('maxParticipants is enforced on manual promotion', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const event = await owner.events.create(
        draft({ maxParticipants: 1, roles: roles({ tank: 5 }) })
      );

      await owner.events.signup({ eventId: event.id, roleKey: 'tank' });
      await member.events.signup({ eventId: event.id, roleKey: 'tank' });

      await expect(
        owner.events.setSignupStatus({ eventId: event.id, userId: 2, status: 'confirmed' })
      ).rejects.toThrow('The event is full');
    });
  });

  test('get returns the roster grouped in role order with a null host when the host is gone', async () => {
    const { caller } = await initTest(1);
    const event = await caller.events.create(draft());
    await getTestDb().update(events).set({ hostId: null }).where(eq(events.id, event.id));

    const detail = await caller.events.get({ eventId: event.id });
    expect(detail.host).toBeNull();
    expect(detail.roster.confirmed.map((g) => g.role.key)).toEqual(['tank', 'healer', 'dps']);
    expect(detail.roster.bench).toEqual([]);
    expect(detail.counts.confirmed).toBe(0);

    const [channel] = await getTestDb()
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, 1), eq(channels.type, ChannelType.VOICE)))
      .limit(1);
    expect(channel).toBeDefined();
  });
});
