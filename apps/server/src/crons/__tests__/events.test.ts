import type { TPluginEventPayload } from '@pulse/plugin-sdk';
import { ChannelPermission, ChannelType, ServerEvents } from '@pulse/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createEmptyTextChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  categories,
  channels,
  channelUserPermissions,
  events,
  messages
} from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';
import { eventsTick, ROOM_LEAD_MS, ROOM_LINGER_MS } from '../events';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type PublishCall = [number | number[], string, unknown];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

/** Publishers resolve their audience first, so a fan-out lands on the spy a tick later. */
const publishedCalls = async (
  spy: { mock: { calls: unknown[][] } },
  topic: string,
  predicate: (call: PublishCall) => boolean = () => true,
  count = 1
) => {
  const matching = () => callsFor(spy, topic).filter(predicate);
  for (let i = 0; i < 200 && matching().length < count; i++) {
    await Bun.sleep(5);
  }
  return matching();
};

const recipients = (call: PublishCall) =>
  [...(Array.isArray(call[0]) ? call[0] : [call[0]])].sort();

const roles = [
  { key: 'tank', label: 'Tank', cap: 1, color: '#60a5fa' },
  { key: 'healer', label: 'Healer', cap: 1, color: null }
];

const eventRow = async (eventId: number) => {
  const [row] = await getTestDb().select().from(events).where(eq(events.id, eventId));
  return row!;
};

const listen = (name: 'event:started' | 'event:ended') => {
  const seen: TPluginEventPayload[] = [];
  const handler = (payload: TPluginEventPayload) => {
    seen.push(payload);
  };
  eventBus.on(name, handler);
  return { seen, stop: () => eventBus.off(name, handler) };
};

describe('events cron', () => {
  test('walks one event through its whole timeline', async () => {
    const tdb = getTestDb();
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const { caller: third } = await initTest(3);
    const announce = await createEmptyTextChannel('raids');
    const startsAt = Date.now() + 48 * HOUR_MS;
    const endsAt = startsAt + 2 * HOUR_MS;

    const event = await owner.events.create({
      title: 'Raid night',
      startsAt,
      endsAt,
      roles,
      announceChannelId: announce.id
    });
    await member.events.signup({ eventId: event.id, roleKey: 'tank' });
    await third.events.signup({ eventId: event.id, roleKey: 'tank' }); // bench

    const spy = spyOn(pubsub, 'publishFor');
    const started = listen('event:started');
    const ended = listen('event:ended');

    try {
      // Nothing is due yet.
      await eventsTick(startsAt - 30 * HOUR_MS);
      expect(callsFor(spy, ServerEvents.EVENT_REMINDER)).toHaveLength(0);
      expect((await eventRow(event.id)).reminderStage).toBe(0);

      // T-24 h: stage 1 to confirmed + bench, once.
      await eventsTick(startsAt - 24 * HOUR_MS + MINUTE_MS);
      let reminders = callsFor(spy, ServerEvents.EVENT_REMINDER);
      expect(reminders).toHaveLength(1);
      expect(recipients(reminders[0]!)).toEqual([2, 3]);
      expect(reminders[0]![2]).toEqual({
        eventId: event.id,
        serverId: 1,
        title: 'Raid night',
        startsAt,
        stage: 1
      });
      expect((await eventRow(event.id)).reminderStage).toBe(1);

      // Same minute again (restart, overlapping tick): not repeated.
      await eventsTick(startsAt - 24 * HOUR_MS + MINUTE_MS);
      expect(callsFor(spy, ServerEvents.EVENT_REMINDER)).toHaveLength(1);

      // T-1 h: stage 2.
      await eventsTick(startsAt - HOUR_MS);
      reminders = callsFor(spy, ServerEvents.EVENT_REMINDER);
      expect(reminders).toHaveLength(2);
      expect((reminders[1]![2] as { stage: number }).stage).toBe(2);
      expect((await eventRow(event.id)).voiceChannelId).toBeNull();

      // T-15 min: the private room appears in "Events" with overrides
      // for the host and the confirmed signup, not the bench.
      await eventsTick(startsAt - ROOM_LEAD_MS);
      const withRoom = await eventRow(event.id);
      expect(withRoom.voiceChannelId).not.toBeNull();
      expect(withRoom.status).toBe('scheduled');
      const roomId = withRoom.voiceChannelId!;

      const [room] = await tdb.select().from(channels).where(eq(channels.id, roomId));
      expect(room!.type).toBe(ChannelType.VOICE);
      expect(room!.private).toBe(true);
      expect(room!.name).toBe('Raid night');
      expect(room!.serverId).toBe(1);
      const [category] = await tdb
        .select()
        .from(categories)
        .where(eq(categories.id, room!.categoryId!));
      expect(category!.name).toBe('Events');
      expect(VoiceRuntime.findById(roomId)).toBeDefined();

      const overrides = await tdb
        .select()
        .from(channelUserPermissions)
        .where(eq(channelUserPermissions.channelId, roomId));
      const allowed = (userId: number, permission: ChannelPermission) =>
        overrides.find((o) => o.userId === userId && o.permission === permission)?.allow;
      expect(allowed(1, ChannelPermission.VIEW_CHANNEL)).toBe(true);
      expect(allowed(1, ChannelPermission.JOIN)).toBe(true);
      expect(allowed(2, ChannelPermission.VIEW_CHANNEL)).toBe(true);
      expect(allowed(2, ChannelPermission.JOIN)).toBe(true);
      expect(allowed(2, ChannelPermission.SPEAK)).toBe(true);
      expect(allowed(3, ChannelPermission.VIEW_CHANNEL)).toBeUndefined();

      const creates = await publishedCalls(
        spy,
        ServerEvents.CHANNEL_CREATE,
        (c) => (c[2] as { id: number }).id === roomId
      );
      expect(creates).toHaveLength(1);
      expect(recipients(creates[0]!)).toEqual([1, 2]);

      // The roster changes while the room exists: the newly confirmed
      // member gains the room, the bench still does not.
      await third.events.signup({ eventId: event.id, roleKey: 'healer' });
      const resynced = await tdb
        .select()
        .from(channelUserPermissions)
        .where(
          and(
            eq(channelUserPermissions.channelId, roomId),
            eq(channelUserPermissions.userId, 3),
            eq(channelUserPermissions.permission, ChannelPermission.JOIN)
          )
        );
      expect(resynced[0]?.allow).toBe(true);
      await third.events.withdraw({ eventId: event.id });
      expect(
        await tdb
          .select()
          .from(channelUserPermissions)
          .where(
            and(
              eq(channelUserPermissions.channelId, roomId),
              eq(channelUserPermissions.userId, 3)
            )
          )
      ).toHaveLength(0);

      // A second tick before the start creates nothing twice.
      await eventsTick(startsAt - 5 * MINUTE_MS);
      expect((await eventRow(event.id)).voiceChannelId).toBe(roomId);
      expect(
        await tdb.select().from(channels).where(eq(channels.categoryId, category!.id))
      ).toHaveLength(1);

      // T: stage 3 reminder, live, plugin event.
      const updatesBefore = callsFor(spy, ServerEvents.EVENT_UPDATE).length;
      await eventsTick(startsAt);
      reminders = callsFor(spy, ServerEvents.EVENT_REMINDER);
      expect(reminders).toHaveLength(3);
      expect((reminders[2]![2] as { stage: number }).stage).toBe(3);
      const live = await eventRow(event.id);
      expect(live.status).toBe('live');
      expect(live.reminderStage).toBe(3);
      expect(started.seen).toHaveLength(1);
      expect(started.seen[0]).toEqual({
        eventId: event.id,
        serverId: 1,
        title: 'Raid night',
        startsAt,
        endsAt,
        status: 'live'
      });
      expect(
        (await publishedCalls(spy, ServerEvents.EVENT_UPDATE, () => true, updatesBefore + 1)).length
      ).toBeGreaterThan(updatesBefore);

      // Someone sits in the room; the scheduled end passes.
      VoiceRuntime.findById(roomId)!.addUser(2, { micMuted: false, soundMuted: false });
      await eventsTick(startsAt + 10 * MINUTE_MS);
      await eventsTick(endsAt + 5 * MINUTE_MS);
      expect((await eventRow(event.id)).status).toBe('live');
      expect(VoiceRuntime.findById(roomId)).toBeDefined();

      // end + 15 min: the lingering occupant is evicted, the room goes,
      // the event is done and the summary lands in the announce channel.
      await eventsTick(endsAt + ROOM_LINGER_MS);
      const done = await eventRow(event.id);
      expect(done.status).toBe('done');
      expect(done.voiceChannelId).toBeNull();
      expect(VoiceRuntime.findById(roomId)).toBeUndefined();
      expect(await tdb.select().from(channels).where(eq(channels.id, roomId))).toHaveLength(0);

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE).filter(
        (c) => (c[2] as { channelId: number }).channelId === roomId
      );
      expect(leaves).toHaveLength(1);
      expect((leaves[0]![2] as { userId: number }).userId).toBe(2);
      expect(
        (await publishedCalls(spy, ServerEvents.CHANNEL_DELETE, (c) => c[2] === roomId)).map((c) => c[2])
      ).toContain(roomId);

      expect(ended.seen).toHaveLength(1);
      expect((ended.seen[0] as { status: string }).status).toBe('done');

      const rows = await tdb
        .select()
        .from(messages)
        .where(eq(messages.channelId, announce.id))
        .orderBy(messages.id);
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[1]!.content!)).toEqual({
        kind: 'event-summary',
        eventId: event.id,
        attended: 1
      });
      expect(rows[1]!.type).toBe('system');

      // Done events are left alone from here on.
      await eventsTick(endsAt + 2 * HOUR_MS);
      expect(await tdb.select().from(messages).where(eq(messages.channelId, announce.id))).toHaveLength(2);
      expect(ended.seen).toHaveLength(1);
    } finally {
      spy.mockRestore();
      started.stop();
      ended.stop();
      const leftover = VoiceRuntime.findById((await eventRow(event.id)).voiceChannelId ?? -1);
      if (leftover) await leftover.destroy();
    }
  });

  test('a stage first seen more than ten minutes late is marked, not sent', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const now = Date.now();
    const startsAt = now + 48 * HOUR_MS;

    const event = await owner.events.create({
      title: 'Late',
      startsAt,
      endsAt: startsAt + HOUR_MS,
      roles
    });
    await member.events.signup({ eventId: event.id, roleKey: 'tank' });

    const spy = spyOn(pubsub, 'publishFor');
    try {
      // The process was down from before T-24 h until T-30 min: the 24 h
      // and 1 h stages are stale (skipped), nothing is sent, both are
      // marked so a later tick never sends them either.
      await eventsTick(startsAt - 30 * MINUTE_MS);
      expect(callsFor(spy, ServerEvents.EVENT_REMINDER)).toHaveLength(0);
      expect((await eventRow(event.id)).reminderStage).toBe(2);

      // Inside the grace window a stage still goes out (restart 5 min
      // after the start).
      await eventsTick(startsAt + 5 * MINUTE_MS);
      const reminders = callsFor(spy, ServerEvents.EVENT_REMINDER);
      expect(reminders).toHaveLength(1);
      expect((reminders[0]![2] as { stage: number }).stage).toBe(3);
      const row = await eventRow(event.id);
      expect(row.reminderStage).toBe(3);
      expect(row.status).toBe('live');
    } finally {
      spy.mockRestore();
      const roomId = (await eventRow(event.id)).voiceChannelId;
      const runtime = roomId ? VoiceRuntime.findById(roomId) : undefined;
      if (runtime) await runtime.destroy();
    }

    // An event created inside the window starts with the stale stages marked.
    const soon = await owner.events.create({
      title: 'Soon',
      startsAt: now + 20 * MINUTE_MS,
      endsAt: now + 80 * MINUTE_MS,
      roles
    });
    expect(soon.reminderStage).toBe(2);
  });

  test('an event whose window passed during downtime goes straight to done without a room', async () => {
    const tdb = getTestDb();
    const { caller } = await initTest(1);
    const startsAt = Date.now() + HOUR_MS;
    const event = await caller.events.create({
      title: 'Missed',
      startsAt,
      endsAt: startsAt + HOUR_MS,
      roles
    });
    const ended = listen('event:ended');

    try {
      await eventsTick(startsAt + HOUR_MS + ROOM_LINGER_MS + 5 * MINUTE_MS);
    } finally {
      ended.stop();
    }

    const row = await eventRow(event.id);
    expect(row.status).toBe('done');
    expect(row.voiceChannelId).toBeNull();
    expect(row.reminderStage).toBe(3);
    expect(ended.seen).toHaveLength(1);
    expect(
      await tdb
        .select()
        .from(categories)
        .where(and(eq(categories.serverId, 1), eq(categories.name, 'Events')))
    ).toHaveLength(0);
  });

  test('the Events category is created once and reused; a cancelled event is left alone', async () => {
    const tdb = getTestDb();
    const { caller } = await initTest(1);
    const startsAt = Date.now() + 2 * HOUR_MS;
    const first = await caller.events.create({
      title: 'A very long raid title that exceeds the limit',
      startsAt,
      endsAt: startsAt + HOUR_MS,
      roles
    });
    const second = await caller.events.create({
      title: 'B',
      startsAt,
      endsAt: startsAt + HOUR_MS,
      roles
    });
    const cancelled = await caller.events.create({
      title: 'C',
      startsAt,
      endsAt: startsAt + HOUR_MS,
      roles
    });
    await caller.events.cancel({ eventId: cancelled.id });

    try {
      await eventsTick(startsAt - ROOM_LEAD_MS);

      const rows = await Promise.all([first, second, cancelled].map((e) => eventRow(e.id)));
      expect(rows[0]!.voiceChannelId).not.toBeNull();
      expect(rows[1]!.voiceChannelId).not.toBeNull();
      expect(rows[2]!.voiceChannelId).toBeNull();
      expect(rows[2]!.status).toBe('cancelled');

      const eventCategories = await tdb
        .select()
        .from(categories)
        .where(and(eq(categories.serverId, 1), eq(categories.name, 'Events')));
      expect(eventCategories).toHaveLength(1);

      const rooms = await tdb
        .select()
        .from(channels)
        .where(eq(channels.categoryId, eventCategories[0]!.id))
        .orderBy(channels.position);
      expect(rooms.map((r) => r.name)).toEqual(['A very long raid title t', 'B']);
      expect(rooms.map((r) => r.position)).toEqual([0, 1]);

      // Cancelling a live event with a room removes the room right away.
      await caller.events.cancel({ eventId: first.id });
      expect(VoiceRuntime.findById(rows[0]!.voiceChannelId!)).toBeUndefined();
      expect(
        await tdb.select().from(channels).where(eq(channels.id, rows[0]!.voiceChannelId!))
      ).toHaveLength(0);
    } finally {
      for (const e of [first, second]) {
        const roomId = (await eventRow(e.id)).voiceChannelId;
        const runtime = roomId ? VoiceRuntime.findById(roomId) : undefined;
        if (runtime) await runtime.destroy();
      }
    }
  });
});
