import { ServerEvents } from '@pulse/shared';
import type { TEvent } from '../types';
import { publishEvent } from '../db/publishers';
import {
  emitPluginEvent,
  ensureEventRoom,
  getReminderRecipientIds,
  listOpenEvents,
  postEventSystemRow,
  reminderMoment,
  REMINDER_STALE_MS,
  removeEventRoom,
  setEventReminderStage,
  setEventStatus,
  type TReminderStage
} from '../db/queries/events';
import { logger } from '../logger';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from '../utils/pubsub';

/**
 * The event timeline, driven once a minute:
 *
 *   T-24 h, T-1 h, T      reminders to the signed-up members
 *   T-15 min              the private voice room appears
 *   T                     status 'live'
 *   end + 15 min          the room goes (occupants evicted), 'done',
 *                         summary row in the announce channel
 *
 * Every step is keyed off persisted state (reminderStage, voiceChannelId,
 * status), so a restart or a missed minute resumes where it left off and
 * nothing is ever sent twice. The teardown is HARD by owner decision: a
 * member still sitting in the room does not keep it alive.
 */

const MINUTE_MS = 60 * 1000;
/** The room exists this long before the start … */
const ROOM_LEAD_MS = 15 * MINUTE_MS;
/** … and this long after the scheduled end, no matter who is still in it. */
const ROOM_LINGER_MS = 15 * MINUTE_MS;
/** Open events walked per tick; a backlog beyond this is handled next minute. */
const TICK_BATCH = 500;

/**
 * Who was seen in the room while the event was live, per event. The
 * tick samples the runtime's occupants every minute (and once more at
 * teardown), so a visit shorter than a minute between two samples can
 * be missed and a restart forgets the set; the summary count is a
 * best-effort "showed up", not an audit trail.
 */
const attendance = new Map<number, Set<number>>();

const sampleAttendance = (event: TEvent) => {
  if (event.voiceChannelId === null) return;

  const runtime = VoiceRuntime.findById(event.voiceChannelId);

  if (!runtime) return;

  const seen = attendance.get(event.id) ?? new Set<number>();

  for (const user of runtime.getState().users) seen.add(user.userId);

  attendance.set(event.id, seen);
};

/**
 * Send every reminder stage that is due and not yet marked. A stage
 * first seen more than REMINDER_STALE_MS after its moment (the process
 * was down, or the event was created inside the window) is marked
 * without sending, so a restart never spams a day-old "24 hours to go".
 */
const sendDueReminders = async (event: TEvent, now: number): Promise<number> => {
  let stage = event.reminderStage;
  let recipients: number[] | undefined;

  for (const next of [1, 2, 3] as const satisfies readonly TReminderStage[]) {
    if (next <= stage) continue;

    const moment = reminderMoment(event.startsAt, next);

    // Stages are ordered in time: the first one still ahead ends the walk.
    if (moment > now) break;

    if (now - moment <= REMINDER_STALE_MS) {
      recipients ??= await getReminderRecipientIds(event.id);

      if (recipients.length > 0) {
        pubsub.publishFor(recipients, ServerEvents.EVENT_REMINDER, {
          eventId: event.id,
          serverId: event.serverId,
          title: event.title,
          startsAt: event.startsAt,
          stage: next
        });
      }
    } else {
      logger.debug(
        '[events] reminder stage %d of event %d skipped as stale',
        next,
        event.id
      );
    }

    stage = next;
  }

  if (stage !== event.reminderStage) {
    await setEventReminderStage(event.id, stage);
  }

  return stage;
};

const processEvent = async (event: TEvent, now: number) => {
  let current = event;
  const teardownAt = current.endsAt + ROOM_LINGER_MS;

  if (current.status === 'scheduled') {
    await sendDueReminders(current, now);

    // No room for an event whose window is already over (long downtime):
    // it goes straight to 'done' below.
    if (now < teardownAt && now >= current.startsAt - ROOM_LEAD_MS) {
      current = await ensureEventRoom(current);
    }

    if (now >= current.startsAt && now < teardownAt) {
      current =
        (await setEventStatus(current.id, 'live')) ?? { ...current, status: 'live' };
      publishEvent(current.id, 'update');
      emitPluginEvent('event:started', current);
    }
  }

  if (current.status === 'live') {
    sampleAttendance(current);
  }

  if (now >= teardownAt) {
    sampleAttendance(current);

    const attended = attendance.get(current.id)?.size ?? 0;
    attendance.delete(current.id);

    current = await removeEventRoom(current);
    current =
      (await setEventStatus(current.id, 'done')) ?? { ...current, status: 'done' };

    publishEvent(current.id, 'update');
    emitPluginEvent('event:ended', current);
    await postEventSystemRow(current, {
      kind: 'event-summary',
      eventId: current.id,
      attended
    });
  }
};

/**
 * One scheduler pass at `now` (injectable for tests). Each event is
 * handled on its own so one failing room creation does not stall the
 * reminders of every other event. Returns the number of events walked.
 */
const eventsTick = async (now: number = Date.now()): Promise<number> => {
  const open = await listOpenEvents(TICK_BATCH);
  let processed = 0;

  for (const event of open) {
    try {
      await processEvent(event, now);
      processed += 1;
    } catch (err) {
      logger.error('[events] tick failed for event %d:', event.id, err);
    }
  }

  return processed;
};

export { eventsTick, ROOM_LEAD_MS, ROOM_LINGER_MS };
