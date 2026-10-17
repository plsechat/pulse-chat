import { asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { createEvent, DEFAULT_ROSTER_TEMPLATES } from '../../db/queries/events';
import { findExternalIdentity } from '../../db/queries/import-jobs';
import { eventRosterTemplates } from '../../db/schema';
import { invalidateFeedCache } from '../../http/events-ics';
import type { TDiscordScheduledEvent } from '../discord/types';
import { boundText, BOUNDS } from '../mapping';
import { IMPORT_PROVIDER, type ImportRun } from '../runner';

/** Source cap: 100 scheduled events per guild. */
const MAX_EVENTS = 100;
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
/** Our events last at most a day (db/queries/events validateWindow). */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const STATUS_SCHEDULED = 1;

/**
 * Upcoming scheduled events become ours through the scheduler's own
 * `createEvent`, so they get the stock roster, the reminders and the
 * voice room like an event created by hand. Past and cancelled ones
 * have nothing to schedule and are counted as skipped. The host is the
 * creator when that person already has an account here (claimed or
 * placeholder); otherwise the event is hostless. The roster is the
 * server's first template (the stock one on a normal server), or the
 * built-in generic roster when the server has none.
 */

const rosterFor = async (serverId: number) => {
  const [template] = await db
    .select({ id: eventRosterTemplates.id })
    .from(eventRosterTemplates)
    .where(eq(eventRosterTemplates.serverId, serverId))
    .orderBy(asc(eventRosterTemplates.id))
    .limit(1);

  return template
    ? { templateId: template.id }
    : { roles: DEFAULT_ROSTER_TEMPLATES[0]!.roles };
};

const runEventsStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('events');
  const list = await run.client.get<TDiscordScheduledEvent[]>(
    `/guilds/${run.guildId}/scheduled-events`
  );
  if (!Array.isArray(list)) return;

  const upcoming = list.slice(0, MAX_EVENTS);
  counts.total = upcoming.length;
  const imported = new Set(run.state.cursor.events ?? []);
  const roster = await rosterFor(run.serverId);

  for (const event of upcoming) {
    if (imported.has(event.id)) {
      counts.done++;
      continue;
    }

    const startsAt = Date.parse(event.scheduled_start_time);
    if (event.status !== STATUS_SCHEDULED || !Number.isFinite(startsAt) || startsAt <= run.now()) {
      counts.skipped++;
      continue;
    }

    const endsAtRaw = event.scheduled_end_time ? Date.parse(event.scheduled_end_time) : NaN;
    const endsAt = Math.min(
      Number.isFinite(endsAtRaw) && endsAtRaw > startsAt ? endsAtRaw : startsAt + DEFAULT_DURATION_MS,
      startsAt + MAX_DURATION_MS
    );

    let hostId: number | null = null;
    if (event.creator_id) {
      hostId =
        run.userCache.get(event.creator_id) ??
        (await findExternalIdentity(IMPORT_PROVIDER, event.creator_id))?.userId ??
        null;
    }

    const location = event.entity_metadata?.location;
    const description = [
      boundText(event.description, BOUNDS.eventDescription - 200),
      location ? `Where: ${boundText(location, 150)}` : ''
    ]
      .filter((part) => part.length > 0)
      .join('\n');

    try {
      await createEvent({
        serverId: run.serverId,
        title: boundText(event.name, BOUNDS.eventTitle, 'Event'),
        description: description || null,
        startsAt,
        endsAt,
        hostId,
        ...roster,
        announceChannelId: null,
        actor: { kind: 'user', userId: run.actorId }
      });
      imported.add(event.id);
      run.state.cursor.events = [...imported];
      counts.done++;
      invalidateFeedCache(run.serverId);
    } catch (error) {
      run.error('events', boundText(event.name, 60, event.id), error);
      counts.skipped++;
    }

    await run.checkpoint();
  }
};

export { runEventsStep };
