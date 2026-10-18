import { ChannelPermission, ChannelType } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  notInArray,
  sql
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '..';
import { logger } from '../../logger';
import { eventBus } from '../../plugins/event-bus';
import { VoiceRuntime } from '../../runtimes/voice';
import type {
  TEvent,
  TEventDetail,
  TEventListItem,
  TEventRole,
  TEventRosterCounts,
  TEventRosterTemplate,
  TEventSignup,
  TEventSignupStatus,
  TUpcomingEvent
} from '../../types';
import { invariant } from '../../utils/invariant';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';
import { evictRuntime } from '../../utils/voice-cleanup';
import {
  publishCategory,
  publishChannel,
  publishChannelPermissions,
  publishChannelVisibility,
  publishEvent,
  publishEventSignups,
  publishMessage
} from '../publishers';
import {
  categories,
  channels,
  channelUserPermissions,
  eventRosterTemplates,
  events,
  eventSignups,
  messages,
  serverMembers,
  servers
} from '../schema';
import { getAffectedUserIdsForChannel } from './channels';
import {
  DEFAULT_ROSTER_TEMPLATES,
  insertDefaultRosterTemplates
} from './event-templates';
import { getPublicUserById } from './users';

/**
 * Scheduled community events ("raids"): the one place that knows the
 * roster rules. The tRPC routes call these with a user actor and the
 * plugin SDK with a plugin actor; fan-out (pubsub) and plugin-bus
 * emission happen in here so both paths behave identically.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type TEventActor =
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'user'; userId: number };

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Longest event; bounds the voice-room lifetime and the calendar maths. */
const MAX_EVENT_DURATION_MS = 24 * HOUR_MS;
/** A "starts now" event typed a moment ago must not be refused. */
const PAST_START_GRACE_MS = 5 * MINUTE_MS;
/** Reminder stages 1..3 fire this long before `startsAt`. */
const REMINDER_OFFSETS_MS = [24 * HOUR_MS, HOUR_MS, 0] as const;
/** A stage first seen more than this long after its moment is skipped, not sent late. */
const REMINDER_STALE_MS = 10 * MINUTE_MS;
/** Hard bound on what one list call or one feed can carry. */
const MAX_LISTED_EVENTS = 500;
/** Category every raid room is created in; made once per server. */
const EVENTS_CATEGORY_NAME = 'Events';
/** channels.add bounds a name to 24; a room named after its event obeys the same. */
const ROOM_NAME_MAX = 24;
/**
 * What a user override on the raid room grants: everything a voice
 * channel needs. A private channel defaults every permission to deny,
 * so a VIEW+JOIN-only override would put people in a room they cannot
 * speak in.
 */
const ROOM_PERMISSIONS: ChannelPermission[] = [
  ChannelPermission.VIEW_CHANNEL,
  ChannelPermission.JOIN,
  ChannelPermission.SPEAK,
  ChannelPermission.SHARE_SCREEN,
  ChannelPermission.WEBCAM
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const eventRoleSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Role keys are letters, digits, - and _'),
  label: z.string().trim().min(1).max(40),
  cap: z.number().int().min(1).max(200).nullable(),
  color: z.string().regex(HEX_COLOR, 'Colours are #rrggbb').nullable()
});

const eventRolesSchema = z
  .array(eventRoleSchema)
  .min(1)
  .max(12)
  .refine(
    (roles) => new Set(roles.map((r) => r.key)).size === roles.length,
    'Role keys must be unique'
  );

const eventFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  gameTag: z.string().trim().max(40).nullable().optional(),
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  maxParticipants: z.number().int().min(1).max(500).nullable().optional(),
  announceChannelId: z.number().int().positive().nullable().optional()
});

const templateNameSchema = z.string().trim().min(1).max(60);

// ─── plugin bus ───────────────────────────────────────────────────────

type TPluginEventName =
  | 'event:created'
  | 'event:updated'
  | 'event:cancelled'
  | 'event:started'
  | 'event:ended';

/** Plugins get the same payload for every lifecycle step (SDK: TPluginEventPayload). */
const emitPluginEvent = (name: TPluginEventName, event: TEvent) => {
  void eventBus.emit(name, {
    eventId: event.id,
    serverId: event.serverId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    status: event.status
  });
};

// ─── reminders ────────────────────────────────────────────────────────

type TReminderStage = 1 | 2 | 3;

const reminderMoment = (startsAt: number, stage: TReminderStage) =>
  startsAt - (REMINDER_OFFSETS_MS[stage - 1] ?? 0);

/**
 * How many stages are already stale at `now` — those are marked sent
 * without a publish. Used by the scheduler's skip rule and by a
 * reschedule, so moving an event to "in 30 minutes" never fires the
 * 24 h and 1 h reminders it just skipped past.
 */
const staleReminderStage = (startsAt: number, now: number): number => {
  let stale = 0;
  for (const stage of [1, 2, 3] as const) {
    if (now - reminderMoment(startsAt, stage) > REMINDER_STALE_MS)
      stale = stage;
  }
  return stale;
};

// ─── validation ───────────────────────────────────────────────────────

const isOpen = (event: Pick<TEvent, 'status'>) =>
  event.status === 'scheduled' || event.status === 'live';

const validateWindow = (
  startsAt: number,
  endsAt: number,
  now: number,
  checkStart: boolean
) => {
  invariant(endsAt > startsAt, 'The event must end after it starts');
  invariant(
    endsAt - startsAt <= MAX_EVENT_DURATION_MS,
    'An event can last at most 24 hours'
  );
  if (checkStart) {
    invariant(
      startsAt >= now - PAST_START_GRACE_MS,
      'The event cannot start in the past'
    );
  }
};

/** Roster from a template of THIS server, or an explicit (bounded) role list. */
const resolveRoles = async (
  serverId: number,
  templateId: number | null | undefined,
  roles: TEventRole[] | undefined
): Promise<{ templateId: number | null; roles: TEventRole[] }> => {
  if (templateId) {
    const [template] = await db
      .select()
      .from(eventRosterTemplates)
      .where(
        and(
          eq(eventRosterTemplates.id, templateId),
          eq(eventRosterTemplates.serverId, serverId)
        )
      )
      .limit(1);

    invariant(template, { code: 'NOT_FOUND', message: 'Template not found' });

    return { templateId: template.id, roles: template.roles };
  }

  invariant(
    roles && roles.length > 0,
    'Pick a roster template or define roles'
  );

  return { templateId: null, roles: eventRolesSchema.parse(roles) };
};

/** The announce channel must be a TEXT channel of the event's server. */
const resolveAnnounceChannel = async (
  serverId: number,
  channelId: number | null | undefined
): Promise<number | null> => {
  if (!channelId) return null;

  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.serverId, serverId),
        eq(channels.type, ChannelType.TEXT)
      )
    )
    .limit(1);

  invariant(channel, { code: 'NOT_FOUND', message: 'Channel not found' });

  return channel.id;
};

const getEventById = async (eventId: number): Promise<TEvent | undefined> => {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  return event;
};

/** Scoped read for the routes: an event of another server is "not found". */
const getEventForServer = async (
  eventId: number,
  serverId: number
): Promise<TEvent | undefined> => {
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.serverId, serverId)))
    .limit(1);

  return event;
};

// ─── system rows ──────────────────────────────────────────────────────

/**
 * A system row in the announce channel (the RSVP card / the summary).
 * Posted under the host, or the server owner for a host-less (plugin)
 * event — messages need an author row. Mirrors the automod alert path.
 */
const postEventSystemRow = async (
  event: TEvent,
  payload: Record<string, unknown>
): Promise<number | undefined> => {
  if (!event.announceChannelId) return undefined;

  let authorId = event.hostId;

  if (authorId === null) {
    const [server] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, event.serverId))
      .limit(1);
    authorId = server?.ownerId ?? null;
  }

  if (authorId === null) {
    logger.warn(
      '[events] announcement skipped: event %d has no host and server %d has no owner',
      event.id,
      event.serverId
    );
    return undefined;
  }

  const [row] = await db
    .insert(messages)
    .values({
      content: JSON.stringify(payload),
      type: 'system',
      userId: authorId,
      channelId: event.announceChannelId,
      editable: false,
      createdAt: Date.now()
    })
    .returning({ id: messages.id });

  if (row) {
    await publishMessage(row.id, event.announceChannelId, 'create');
  }

  return row?.id;
};

// ─── counts / roster ──────────────────────────────────────────────────

const emptyCounts = (roles: TEventRole[]): TEventRosterCounts => ({
  byRole: Object.fromEntries(
    roles.map((role) => [role.key, { confirmed: 0, bench: 0 }])
  ),
  confirmed: 0,
  bench: 0,
  declined: 0
});

/** Roster totals per event, every defined role present even when empty. */
const getEventRosterCounts = async (
  eventIds: number[]
): Promise<Map<number, TEventRosterCounts>> => {
  const result = new Map<number, TEventRosterCounts>();

  if (eventIds.length === 0) return result;

  const rows = await db
    .select({ id: events.id, roles: events.roles })
    .from(events)
    .where(inArray(events.id, eventIds));

  for (const row of rows) result.set(row.id, emptyCounts(row.roles));

  const grouped = await db
    .select({
      eventId: eventSignups.eventId,
      roleKey: eventSignups.roleKey,
      status: eventSignups.status,
      count: sql<number>`count(*)::int`
    })
    .from(eventSignups)
    .where(inArray(eventSignups.eventId, eventIds))
    .groupBy(eventSignups.eventId, eventSignups.roleKey, eventSignups.status);

  for (const group of grouped) {
    const counts = result.get(group.eventId);
    if (!counts) continue;

    if (group.status === 'declined') {
      counts.declined += group.count;
      continue;
    }

    counts[group.status] += group.count;
    const role = (counts.byRole[group.roleKey] ??= { confirmed: 0, bench: 0 });
    role[group.status] += group.count;
  }

  return result;
};

const listEvents = async (
  serverId: number,
  from: number,
  to: number,
  userId: number
): Promise<TEventListItem[]> => {
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.serverId, serverId),
        lte(events.startsAt, to),
        gte(events.endsAt, from)
      )
    )
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(MAX_LISTED_EVENTS);

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [counts, own] = await Promise.all([
    getEventRosterCounts(ids),
    db
      .select({
        eventId: eventSignups.eventId,
        roleKey: eventSignups.roleKey,
        status: eventSignups.status,
        position: eventSignups.position
      })
      .from(eventSignups)
      .where(
        and(inArray(eventSignups.eventId, ids), eq(eventSignups.userId, userId))
      )
  ]);
  const ownByEvent = new Map(own.map((row) => [row.eventId, row]));

  return rows.map((row) => {
    const ownRow = ownByEvent.get(row.id);
    return {
      ...row,
      counts: counts.get(row.id) ?? emptyCounts(row.roles),
      ownSignup: ownRow
        ? {
            roleKey: ownRow.roleKey,
            status: ownRow.status,
            position: ownRow.position
          }
        : null
    };
  });
};

const getEventDetail = async (
  eventId: number,
  serverId: number
): Promise<TEventDetail | undefined> => {
  const event = await getEventForServer(eventId, serverId);

  if (!event) return undefined;

  const [signups, counts, host] = await Promise.all([
    db
      .select()
      .from(eventSignups)
      .where(eq(eventSignups.eventId, event.id))
      .orderBy(asc(eventSignups.position), asc(eventSignups.id)),
    getEventRosterCounts([event.id]),
    event.hostId !== null ? getPublicUserById(event.hostId) : undefined
  ]);

  const confirmed = event.roles.map((role) => ({
    role,
    signups: signups.filter(
      (signup) => signup.status === 'confirmed' && signup.roleKey === role.key
    )
  }));

  return {
    event,
    counts: counts.get(event.id) ?? emptyCounts(event.roles),
    roster: {
      confirmed,
      bench: signups.filter((signup) => signup.status === 'bench'),
      declined: signups.filter((signup) => signup.status === 'declined').length
    },
    host: host ? { id: host.id, name: host.name, avatar: host.avatar } : null
  };
};

// ─── voice room ───────────────────────────────────────────────────────

const roomNameFor = (title: string) =>
  title.trim().slice(0, ROOM_NAME_MAX).trim() || 'Event';

/** The "Events" category, created once per server at the end of the list. */
const ensureEventsCategory = async (serverId: number): Promise<number> => {
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.serverId, serverId),
        eq(categories.name, EVENTS_CATEGORY_NAME)
      )
    )
    .orderBy(asc(categories.id))
    .limit(1);

  if (existing) return existing.id;

  const [max] = await db
    .select({ maxPos: sql<number>`COALESCE(MAX(${categories.position}), 0)` })
    .from(categories)
    .where(eq(categories.serverId, serverId));

  const [created] = await db
    .insert(categories)
    .values({
      name: EVENTS_CATEGORY_NAME,
      position: (max?.maxPos ?? 0) + 1,
      serverId,
      createdAt: Date.now()
    })
    .returning({ id: categories.id });

  publishCategory(created!.id, 'create');

  return created!.id;
};

/** Who the room is for: the host plus every confirmed signup. */
const roomMemberIds = async (event: TEvent): Promise<Set<number>> => {
  const confirmed = await db
    .select({ userId: eventSignups.userId })
    .from(eventSignups)
    .where(
      and(
        eq(eventSignups.eventId, event.id),
        eq(eventSignups.status, 'confirmed')
      )
    );

  const ids = new Set(confirmed.map((row) => row.userId));
  if (event.hostId !== null) ids.add(event.hostId);

  return ids;
};

const overrideRows = (
  channelId: number,
  userIds: Iterable<number>,
  now: number
) =>
  Array.from(userIds).flatMap((userId) =>
    Object.values(ChannelPermission).map((permission) => ({
      channelId,
      userId,
      permission,
      allow: ROOM_PERMISSIONS.includes(permission),
      createdAt: now
    }))
  );

/**
 * Create the private voice room for an event that has none yet (T-15
 * min). Overrides come before the create fan-out so the first
 * CHANNEL_CREATE already reaches exactly the roster.
 */
const ensureEventRoom = async (event: TEvent): Promise<TEvent> => {
  if (event.voiceChannelId !== null) return event;

  const now = Date.now();
  const categoryId = await ensureEventsCategory(event.serverId);
  const members = await roomMemberIds(event);

  const channel = await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ maxPos: sql<number>`COALESCE(MAX(${channels.position}), -1)` })
      .from(channels)
      .where(eq(channels.categoryId, categoryId));

    const [created] = await tx
      .insert(channels)
      .values({
        type: ChannelType.VOICE,
        name: roomNameFor(event.title),
        position: (max?.maxPos ?? -1) + 1,
        private: true,
        fileAccessToken: randomUUIDv7(),
        fileAccessTokenUpdatedAt: now,
        categoryId,
        serverId: event.serverId,
        publicId: randomUUIDv7(),
        createdAt: now
      })
      .returning();

    if (members.size > 0) {
      await tx
        .insert(channelUserPermissions)
        .values(overrideRows(created!.id, members, now));
    }

    return created!;
  });

  // Same as channels.add: a voice channel needs its mediasoup router.
  await new VoiceRuntime(channel.id).init();

  const [updated] = await db
    .update(events)
    .set({ voiceChannelId: channel.id, updatedAt: now })
    .where(eq(events.id, event.id))
    .returning();

  invalidateAllPermissionCaches();
  publishChannelPermissions(await getAffectedUserIdsForChannel(channel.id));
  publishChannel(channel.id, 'create');

  return updated ?? { ...event, voiceChannelId: channel.id };
};

/**
 * Bring the room's overrides back in line with the roster after a
 * signup change: newly confirmed members gain the room, members who
 * left it lose it (sidebar + permission map both re-synced).
 */
const syncEventRoomOverrides = async (eventId: number): Promise<void> => {
  const event = await getEventById(eventId);

  if (!event || event.voiceChannelId === null) return;

  const channelId = event.voiceChannelId;
  const desired = await roomMemberIds(event);
  const existingRows = await db
    .selectDistinct({ userId: channelUserPermissions.userId })
    .from(channelUserPermissions)
    .where(eq(channelUserPermissions.channelId, channelId));
  const existing = new Set(existingRows.map((row) => row.userId));

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) return;

  await db.transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx
        .delete(channelUserPermissions)
        .where(
          and(
            eq(channelUserPermissions.channelId, channelId),
            inArray(channelUserPermissions.userId, toRemove)
          )
        );
    }

    if (toAdd.length > 0) {
      await tx
        .insert(channelUserPermissions)
        .values(overrideRows(channelId, toAdd, Date.now()));
    }
  });

  invalidateAllPermissionCaches();
  publishChannelPermissions([
    ...new Set([
      ...(await getAffectedUserIdsForChannel(channelId)),
      ...toRemove
    ])
  ]);
  await publishChannelVisibility(channelId);
};

/**
 * Tear the room down the way channels.delete does: occupants are
 * evicted (USER_LEAVE_VOICE to the server) before the row goes.
 */
const removeEventRoom = async (event: TEvent): Promise<TEvent> => {
  if (event.voiceChannelId === null) return event;

  const channelId = event.voiceChannelId;
  const runtime = VoiceRuntime.findById(channelId);

  if (runtime) {
    await evictRuntime(runtime);
  }

  const [removed] = await db
    .delete(channels)
    .where(
      and(eq(channels.id, channelId), eq(channels.serverId, event.serverId))
    )
    .returning({ id: channels.id });

  if (removed) {
    publishChannel(removed.id, 'delete', event.serverId);
  }

  const [updated] = await db
    .update(events)
    .set({ voiceChannelId: null, updatedAt: Date.now() })
    .where(eq(events.id, event.id))
    .returning();

  return updated ?? { ...event, voiceChannelId: null };
};

// ─── create / update / cancel ─────────────────────────────────────────

type TCreateEventInput = {
  serverId: number;
  title: string;
  description?: string | null;
  gameTag?: string | null;
  startsAt: number;
  endsAt: number;
  hostId: number | null;
  templateId?: number | null;
  roles?: TEventRole[];
  maxParticipants?: number | null;
  announceChannelId?: number | null;
  actor: TEventActor;
};

const createEvent = async (input: TCreateEventInput): Promise<TEvent> => {
  const now = Date.now();
  const fields = eventFieldsSchema.parse(input);

  validateWindow(fields.startsAt, fields.endsAt, now, true);

  const roster = await resolveRoles(
    input.serverId,
    input.templateId,
    input.roles
  );
  const announceChannelId = await resolveAnnounceChannel(
    input.serverId,
    fields.announceChannelId
  );

  const [event] = await db
    .insert(events)
    .values({
      serverId: input.serverId,
      title: fields.title,
      description: fields.description ?? null,
      gameTag: fields.gameTag || null,
      startsAt: fields.startsAt,
      endsAt: fields.endsAt,
      hostId: input.hostId,
      templateId: roster.templateId,
      roles: roster.roles,
      maxParticipants: fields.maxParticipants ?? null,
      announceChannelId,
      status: 'scheduled',
      // A reminder whose moment is already gone is never sent late.
      reminderStage: staleReminderStage(fields.startsAt, now),
      createdAt: now,
      updatedAt: now
    })
    .returning();

  logger.debug(
    '[events] created %d in server %d by %s',
    event!.id,
    event!.serverId,
    input.actor.kind === 'user'
      ? `user ${input.actor.userId}`
      : `plugin ${input.actor.pluginId}`
  );

  publishEvent(event!.id, 'create');
  emitPluginEvent('event:created', event!);
  await postEventSystemRow(event!, { kind: 'event', eventId: event!.id });

  return event!;
};

type TUpdateEventPatch = Partial<{
  title: string;
  description: string | null;
  gameTag: string | null;
  startsAt: number;
  endsAt: number;
  templateId: number | null;
  roles: TEventRole[];
  maxParticipants: number | null;
  announceChannelId: number | null;
}>;

const updateEvent = async (
  eventId: number,
  patch: TUpdateEventPatch,
  actor: TEventActor
): Promise<TEvent> => {
  const event = await getEventById(eventId);

  invariant(event, { code: 'NOT_FOUND', message: 'Event not found' });
  invariant(isOpen(event), 'This event is closed');

  const now = Date.now();
  const fields = eventFieldsSchema.parse({
    title: patch.title ?? event.title,
    description:
      patch.description === undefined ? event.description : patch.description,
    gameTag: patch.gameTag === undefined ? event.gameTag : patch.gameTag,
    startsAt: patch.startsAt ?? event.startsAt,
    endsAt: patch.endsAt ?? event.endsAt,
    maxParticipants:
      patch.maxParticipants === undefined
        ? event.maxParticipants
        : patch.maxParticipants,
    announceChannelId:
      patch.announceChannelId === undefined
        ? event.announceChannelId
        : patch.announceChannelId
  });
  const startChanged = fields.startsAt !== event.startsAt;

  validateWindow(fields.startsAt, fields.endsAt, now, startChanged);

  const rolesChanged =
    patch.templateId !== undefined || patch.roles !== undefined;
  const roster = rolesChanged
    ? await resolveRoles(event.serverId, patch.templateId, patch.roles)
    : { templateId: event.templateId, roles: event.roles };
  const announceChannelId =
    patch.announceChannelId === undefined
      ? event.announceChannelId
      : await resolveAnnounceChannel(event.serverId, patch.announceChannelId);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(events)
      .set({
        title: fields.title,
        description: fields.description ?? null,
        gameTag: fields.gameTag || null,
        startsAt: fields.startsAt,
        endsAt: fields.endsAt,
        templateId: roster.templateId,
        roles: roster.roles,
        maxParticipants: fields.maxParticipants ?? null,
        announceChannelId,
        // Moving the start re-arms the reminders that are still ahead;
        // the ones already behind the new start are marked, not sent.
        reminderStage: startChanged
          ? staleReminderStage(fields.startsAt, now)
          : event.reminderStage,
        updatedAt: now
      })
      .where(eq(events.id, event.id))
      .returning();

    if (rolesChanged) {
      // Signups whose role survived keep their slot; the rest go to the
      // bench (keeping their old key so the host sees what they picked)
      // and re-enter the roster when they choose a role that exists.
      const keys = roster.roles.map((role) => role.key);
      const [max] = await tx
        .select({
          maxPos: sql<number>`COALESCE(MAX(${eventSignups.position}), 0)`
        })
        .from(eventSignups)
        .where(eq(eventSignups.eventId, event.id));
      const orphaned = await tx
        .select({ id: eventSignups.id })
        .from(eventSignups)
        .where(
          and(
            eq(eventSignups.eventId, event.id),
            eq(eventSignups.status, 'confirmed'),
            notInArray(eventSignups.roleKey, keys)
          )
        )
        .orderBy(asc(eventSignups.position), asc(eventSignups.id));

      let position = max?.maxPos ?? 0;
      for (const signup of orphaned) {
        position += 1;
        await tx
          .update(eventSignups)
          .set({ status: 'bench', position })
          .where(eq(eventSignups.id, signup.id));
      }
    }

    return row!;
  });

  if (updated.voiceChannelId !== null && updated.title !== event.title) {
    await db
      .update(channels)
      .set({ name: roomNameFor(updated.title), updatedAt: now })
      .where(eq(channels.id, updated.voiceChannelId));
    publishChannel(updated.voiceChannelId, 'update');
  }

  logger.debug(
    '[events] updated %d by %s',
    updated.id,
    actor.kind === 'user' ? `user ${actor.userId}` : `plugin ${actor.pluginId}`
  );

  publishEvent(updated.id, 'update');
  emitPluginEvent('event:updated', updated);

  if (rolesChanged) {
    publishEventSignups(updated.id);
    await syncEventRoomOverrides(updated.id);
  }

  return updated;
};

const cancelEvent = async (
  eventId: number,
  actor: TEventActor
): Promise<void> => {
  const event = await getEventById(eventId);

  invariant(event, { code: 'NOT_FOUND', message: 'Event not found' });
  invariant(isOpen(event), 'This event is already closed');

  const [cancelled] = await db
    .update(events)
    .set({ status: 'cancelled', updatedAt: Date.now() })
    .where(eq(events.id, event.id))
    .returning();

  // The room goes at once — nobody should sit in a room for a raid that
  // is not happening — rather than at the scheduled teardown.
  const withoutRoom = await removeEventRoom(cancelled!);

  logger.debug(
    '[events] cancelled %d by %s',
    event.id,
    actor.kind === 'user' ? `user ${actor.userId}` : `plugin ${actor.pluginId}`
  );

  // The row stays, marked cancelled, so members see WHY it is gone from
  // their plans; an update (not a delete) keeps the sheet open on it.
  publishEvent(withoutRoom.id, 'update');
  emitPluginEvent('event:cancelled', withoutRoom);
};

// ─── signups ──────────────────────────────────────────────────────────

/** The event row under a row lock so two concurrent signups cannot both take the last slot. */
const lockEvent = async (tx: Tx, eventId: number): Promise<TEvent> => {
  const [event] = await tx
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for('update');

  invariant(event, { code: 'NOT_FOUND', message: 'Event not found' });

  return event;
};

const signupRows = (tx: Tx, eventId: number) =>
  tx
    .select()
    .from(eventSignups)
    .where(eq(eventSignups.eventId, eventId))
    .orderBy(asc(eventSignups.position), asc(eventSignups.id));

const nextPosition = (rows: Pick<TEventSignup, 'position'>[]) =>
  rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;

/** Would `userId` fit as confirmed in `roleKey` right now (ignoring their own row)? */
const hasRoom = (
  event: TEvent,
  rows: TEventSignup[],
  userId: number,
  roleKey: string
) => {
  const role = event.roles.find((r) => r.key === roleKey);

  invariant(role, 'Unknown role');

  const others = rows.filter(
    (r) => r.status === 'confirmed' && r.userId !== userId
  );
  const inRole = others.filter((r) => r.roleKey === roleKey).length;

  return {
    role: role.cap === null || inRole < role.cap,
    event:
      event.maxParticipants === null || others.length < event.maxParticipants
  };
};

/**
 * The first bench entry of `roleKey` (lowest position) takes a freed
 * slot, if the role and the event still have room. One promotion per
 * freed slot — a withdraw frees exactly one.
 */
const autoPromote = async (
  tx: Tx,
  event: TEvent,
  roleKey: string
): Promise<number | null> => {
  const rows = await signupRows(tx, event.id);
  const candidate = rows.find(
    (r) => r.status === 'bench' && r.roleKey === roleKey
  );

  if (!candidate) return null;

  const room = hasRoom(event, rows, candidate.userId, roleKey);

  if (!room.role || !room.event) return null;

  await tx
    .update(eventSignups)
    .set({ status: 'confirmed', position: nextPosition(rows) })
    .where(eq(eventSignups.id, candidate.id));

  return candidate.userId;
};

/** After every roster change: counts to the server, room overrides if the room exists. */
const afterRosterChange = async (event: TEvent) => {
  publishEventSignups(event.id);

  if (event.voiceChannelId !== null) {
    await syncEventRoomOverrides(event.id);
  }
};

type TSignupResult = { signup: TEventSignup; promotedUserId: number | null };

const signupForEvent = async (
  eventId: number,
  userId: number,
  roleKey: string
): Promise<TSignupResult> => {
  const result = await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);

    invariant(isOpen(event), 'This event is closed');

    const rows = await signupRows(tx, event.id);
    const existing = rows.find((r) => r.userId === userId);

    // Already placed in that role: nothing to move, keep their position.
    if (
      existing &&
      existing.roleKey === roleKey &&
      existing.status !== 'declined'
    ) {
      return { event, signup: existing, promotedUserId: null };
    }

    const room = hasRoom(event, rows, userId, roleKey);
    const status: TEventSignupStatus =
      room.role && room.event ? 'confirmed' : 'bench';
    const position = nextPosition(rows);

    const [signup] = await tx
      .insert(eventSignups)
      .values({
        eventId: event.id,
        userId,
        roleKey,
        status,
        position,
        createdAt: Date.now()
      })
      .onConflictDoUpdate({
        target: [eventSignups.eventId, eventSignups.userId],
        set: { roleKey, status, position }
      })
      .returning();

    // Leaving a confirmed slot in another role frees it for that bench.
    const promotedUserId =
      existing &&
      existing.status === 'confirmed' &&
      existing.roleKey !== roleKey
        ? await autoPromote(tx, event, existing.roleKey)
        : null;

    return { event, signup: signup!, promotedUserId };
  });

  await afterRosterChange(result.event);

  return { signup: result.signup, promotedUserId: result.promotedUserId };
};

const declineEvent = async (
  eventId: number,
  userId: number
): Promise<TSignupResult> => {
  const result = await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);

    invariant(isOpen(event), 'This event is closed');

    const rows = await signupRows(tx, event.id);
    const existing = rows.find((r) => r.userId === userId);

    const [signup] = await tx
      .insert(eventSignups)
      .values({
        eventId: event.id,
        userId,
        // A decline without a prior signup has no role; the key is only
        // meaningful for confirmed/bench rows.
        roleKey: existing?.roleKey ?? '',
        status: 'declined',
        position: nextPosition(rows),
        createdAt: Date.now()
      })
      .onConflictDoUpdate({
        target: [eventSignups.eventId, eventSignups.userId],
        set: { status: 'declined' }
      })
      .returning();

    const promotedUserId =
      existing?.status === 'confirmed'
        ? await autoPromote(tx, event, existing.roleKey)
        : null;

    return { event, signup: signup!, promotedUserId };
  });

  await afterRosterChange(result.event);

  return { signup: result.signup, promotedUserId: result.promotedUserId };
};

const withdrawFromEvent = async (
  eventId: number,
  userId: number
): Promise<{ promotedUserId: number | null }> => {
  const result = await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);

    invariant(isOpen(event), 'This event is closed');

    const [removed] = await tx
      .delete(eventSignups)
      .where(
        and(eq(eventSignups.eventId, event.id), eq(eventSignups.userId, userId))
      )
      .returning();

    const promotedUserId =
      removed?.status === 'confirmed'
        ? await autoPromote(tx, event, removed.roleKey)
        : null;

    return { event, promotedUserId };
  });

  await afterRosterChange(result.event);

  return { promotedUserId: result.promotedUserId };
};

/**
 * Manual roster control by the host: promotion honours the caps like a
 * signup does; benching is deliberate, so it does NOT auto-promote — the
 * host is rearranging and decides who takes the slot.
 */
const setSignupStatus = async (
  eventId: number,
  userId: number,
  status: 'confirmed' | 'bench',
  roleKey?: string
): Promise<TEventSignup> => {
  const result = await db.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);

    invariant(isOpen(event), 'This event is closed');

    const rows = await signupRows(tx, event.id);
    const existing = rows.find((r) => r.userId === userId);

    invariant(existing, { code: 'NOT_FOUND', message: 'Signup not found' });

    const targetRole = roleKey ?? existing.roleKey;

    if (status === 'confirmed') {
      const room = hasRoom(event, rows, userId, targetRole);

      invariant(room.role, 'That role is full');
      invariant(room.event, 'The event is full');
    } else {
      invariant(
        event.roles.some((r) => r.key === targetRole),
        'Unknown role'
      );
    }

    const [signup] = await tx
      .update(eventSignups)
      .set({ status, roleKey: targetRole, position: nextPosition(rows) })
      .where(eq(eventSignups.id, existing.id))
      .returning();

    return { event, signup: signup! };
  });

  await afterRosterChange(result.event);

  return result.signup;
};

// ─── templates ────────────────────────────────────────────────────────

const isUniqueViolation = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const listRosterTemplates = (
  serverId: number
): Promise<TEventRosterTemplate[]> =>
  db
    .select()
    .from(eventRosterTemplates)
    .where(eq(eventRosterTemplates.serverId, serverId))
    .orderBy(asc(eventRosterTemplates.name), asc(eventRosterTemplates.id));

const createRosterTemplate = async (
  serverId: number,
  name: string,
  roles: TEventRole[]
): Promise<TEventRosterTemplate> => {
  try {
    const [template] = await db
      .insert(eventRosterTemplates)
      .values({
        serverId,
        name: templateNameSchema.parse(name),
        roles: eventRolesSchema.parse(roles),
        createdAt: Date.now()
      })
      .returning();

    return template!;
  } catch (err) {
    invariant(!isUniqueViolation(err), {
      code: 'CONFLICT',
      message: 'A template with that name already exists'
    });
    throw err;
  }
};

const updateRosterTemplate = async (
  serverId: number,
  templateId: number,
  patch: Partial<{ name: string; roles: TEventRole[] }>
): Promise<TEventRosterTemplate> => {
  try {
    const [template] = await db
      .update(eventRosterTemplates)
      .set({
        ...(patch.name !== undefined
          ? { name: templateNameSchema.parse(patch.name) }
          : {}),
        ...(patch.roles !== undefined
          ? { roles: eventRolesSchema.parse(patch.roles) }
          : {})
      })
      .where(
        and(
          eq(eventRosterTemplates.id, templateId),
          eq(eventRosterTemplates.serverId, serverId)
        )
      )
      .returning();

    invariant(template, { code: 'NOT_FOUND', message: 'Template not found' });

    return template;
  } catch (err) {
    invariant(!isUniqueViolation(err), {
      code: 'CONFLICT',
      message: 'A template with that name already exists'
    });
    throw err;
  }
};

/** Events keep their role snapshot, so deleting a template never reshapes a roster. */
const deleteRosterTemplate = async (
  serverId: number,
  templateId: number
): Promise<void> => {
  const [removed] = await db
    .delete(eventRosterTemplates)
    .where(
      and(
        eq(eventRosterTemplates.id, templateId),
        eq(eventRosterTemplates.serverId, serverId)
      )
    )
    .returning({ id: eventRosterTemplates.id });

  invariant(removed, { code: 'NOT_FOUND', message: 'Template not found' });
};

// ─── scheduler support ────────────────────────────────────────────────

/** Open events, soonest first; the scheduler walks these every minute. */
/**
 * The scheduler's work list. A community with the Planner switched off
 * is left out entirely: no reminders, no room, no status change — its
 * events freeze where they are and the tick picks them up again (stale
 * reminders marked, not sent) once the switch is back on.
 */
const listOpenEvents = (limit: number): Promise<TEvent[]> =>
  db
    .select({ event: events })
    .from(events)
    .innerJoin(servers, eq(servers.id, events.serverId))
    .where(
      and(
        inArray(events.status, ['scheduled', 'live']),
        eq(servers.enableEvents, true)
      )
    )
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(limit)
    .then((rows) => rows.map((row) => row.event));

/** Everyone a reminder goes to: confirmed and benched signups. */
const getReminderRecipientIds = async (eventId: number): Promise<number[]> => {
  const rows = await db
    .select({ userId: eventSignups.userId })
    .from(eventSignups)
    .where(
      and(
        eq(eventSignups.eventId, eventId),
        inArray(eventSignups.status, ['confirmed', 'bench'])
      )
    );

  return rows.map((row) => row.userId);
};

const setEventReminderStage = async (eventId: number, stage: number) => {
  await db
    .update(events)
    .set({ reminderStage: stage })
    .where(eq(events.id, eventId));
};

const setEventStatus = async (
  eventId: number,
  status: TEvent['status']
): Promise<TEvent | undefined> => {
  const [row] = await db
    .update(events)
    .set({ status, updatedAt: Date.now() })
    .where(eq(events.id, eventId))
    .returning();

  return row;
};

/** Non-cancelled events of a server in a window, soonest first (the calendar feed). */
const listFeedEvents = (
  serverId: number,
  from: number,
  to: number
): Promise<TEvent[]> =>
  db
    .select()
    .from(events)
    .where(
      and(
        eq(events.serverId, serverId),
        sql`${events.status} <> 'cancelled'`,
        lte(events.startsAt, to),
        gte(events.endsAt, from)
      )
    )
    .orderBy(desc(events.startsAt))
    .limit(MAX_LISTED_EVENTS);

// ─── Home overview ────────────────────────────────────────────────────

/**
 * The next scheduled events across every community the user is a
 * member of, soonest first, for the Home overview. Membership is the
 * `server_members` row on THIS instance: a community joined on a
 * federated peer has no row here (its events live on that peer), so it
 * never contributes. Only `scheduled` rows count — a live or finished
 * event belongs to the planner, not to "upcoming".
 */
const listUpcomingEventsForUser = async (
  userId: number,
  now: number,
  withinMs: number,
  limit: number
): Promise<TUpcomingEvent[]> => {
  const rows = await db
    .select({
      event: events,
      serverPublicId: servers.publicId,
      serverName: servers.name
    })
    .from(events)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, events.serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .innerJoin(servers, eq(servers.id, events.serverId))
    .where(
      and(
        eq(events.status, 'scheduled'),
        // a community with the Planner off keeps its rows but shows none
        eq(servers.enableEvents, true),
        gte(events.startsAt, now),
        lte(events.startsAt, now + withinMs)
      )
    )
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(limit);

  if (rows.length === 0) return [];

  const own = await db
    .select({
      eventId: eventSignups.eventId,
      roleKey: eventSignups.roleKey,
      status: eventSignups.status
    })
    .from(eventSignups)
    .where(
      and(
        inArray(
          eventSignups.eventId,
          rows.map((row) => row.event.id)
        ),
        eq(eventSignups.userId, userId)
      )
    );
  const ownByEvent = new Map(own.map((row) => [row.eventId, row]));

  return rows.map(({ event, serverPublicId, serverName }) => {
    const signup = ownByEvent.get(event.id);
    const role =
      signup && signup.status !== 'declined'
        ? event.roles.find((r) => r.key === signup.roleKey)
        : undefined;
    return {
      serverId: event.serverId,
      serverPublicId,
      serverName,
      event: {
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        status: event.status,
        hostId: event.hostId
      },
      mySignupStatus: signup?.status ?? null,
      // A benched signup whose role was removed keeps its old key; the
      // key alone is no label, so it reads as "signed up" without one.
      mySignupRole: role?.label ?? null
    };
  });
};

export {
  cancelEvent,
  createEvent,
  createRosterTemplate,
  declineEvent,
  DEFAULT_ROSTER_TEMPLATES,
  deleteRosterTemplate,
  emitPluginEvent,
  ensureEventRoom,
  eventFieldsSchema,
  eventRolesSchema,
  getEventById,
  getEventDetail,
  getEventForServer,
  getEventRosterCounts,
  getReminderRecipientIds,
  insertDefaultRosterTemplates,
  listEvents,
  listFeedEvents,
  listOpenEvents,
  listRosterTemplates,
  listUpcomingEventsForUser,
  postEventSystemRow,
  REMINDER_STALE_MS,
  reminderMoment,
  removeEventRoom,
  setEventReminderStage,
  setEventStatus,
  setSignupStatus,
  signupForEvent,
  staleReminderStage,
  templateNameSchema,
  updateEvent,
  updateRosterTemplate,
  withdrawFromEvent
};
export type { TEventActor, TReminderStage };
