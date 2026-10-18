import type {
  PluginContext,
  TPluginCreateEventInput,
  TPluginEvent,
  TPluginUpdateEventInput
} from '@pulse/plugin-sdk';
import { z } from 'zod';
import { parseActionInput, PluginActionError } from '../errors';

/**
 * `ctx.actions.events` — scheduled events (the raid planner) from a
 * plugin. The scheduler's query layer (db/queries/events.ts) does the
 * work and the publishing, so a plugin-made event behaves exactly like
 * one made from the client; this module only validates and maps.
 *
 * The queries are loaded lazily and by a literal specifier: lazily so a
 * server built without the scheduler still boots and answers
 * UNAVAILABLE here, literal because `bun build --compile` only bundles
 * modules it can see in an `import()` expression.
 */

/** The contract db/queries/events.ts exports for the SDK (IMPL-F1 "Interface for F0"). */
type TEventActor = { kind: 'plugin'; pluginId: string } | { kind: 'user'; userId: number };

type TEventQueries = {
  createEvent: (
    input: TPluginCreateEventInput & { hostId: number | null; actor: TEventActor }
  ) => Promise<TPluginEvent>;
  updateEvent: (
    eventId: number,
    patch: TPluginUpdateEventInput,
    actor: TEventActor
  ) => Promise<TPluginEvent>;
  cancelEvent: (eventId: number, actor: TEventActor) => Promise<void>;
  /** Optional: lets a cancellation find the server whose feed to refresh. */
  getEventById?: (eventId: number) => Promise<{ serverId: number } | undefined>;
  /**
   * Optional: the community's Planner switch. When the loaded module
   * has it, every action refuses for a server that turned the Planner
   * off; a module without it (a stub in tests) is treated as always on.
   */
  isEventsEnabled?: (serverId: number) => Promise<boolean>;
};

type TEventQueriesLoader = () => Promise<Partial<TEventQueries>>;

const defaultLoader: TEventQueriesLoader = async () => {
  const [queries, server] = await Promise.all([
    import('../../db/queries/events'),
    import('../../db/queries/server')
  ]);

  return {
    ...(queries as Partial<TEventQueries>),
    isEventsEnabled: server.isEventsEnabled
  };
};

/** The message a plugin sees when the community has the Planner turned off. */
const PLANNER_OFF_MESSAGE = 'The Planner is turned off in this community';

/** Same bounds as the events router. */
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_GAME_TAG_LENGTH = 40;
const MAX_ROLES = 12;
const MAX_ROLE_KEY_LENGTH = 24;
const MAX_ROLE_LABEL_LENGTH = 40;
const MAX_ROLE_CAP = 200;
const MAX_PARTICIPANTS = 500;
const MAX_EVENT_LENGTH_MS = 24 * 60 * 60 * 1000;

const id = z.number().int().positive();
const epochMs = z.number().int().nonnegative();

const roleSchema = z.object({
  key: z.string().trim().min(1).max(MAX_ROLE_KEY_LENGTH),
  label: z.string().trim().min(1).max(MAX_ROLE_LABEL_LENGTH),
  cap: z.number().int().min(1).max(MAX_ROLE_CAP).nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'color must be a #rrggbb hex value')
    .nullable()
});

const eventFields = {
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
  gameTag: z.string().trim().max(MAX_GAME_TAG_LENGTH).optional(),
  startsAt: epochMs,
  endsAt: epochMs,
  hostId: id.nullable().optional(),
  roles: z.array(roleSchema).min(1).max(MAX_ROLES),
  maxParticipants: z.number().int().min(1).max(MAX_PARTICIPANTS).optional(),
  announceChannelId: id.optional()
};

const windowIsSane = (v: { startsAt?: number; endsAt?: number }) =>
  v.startsAt === undefined ||
  v.endsAt === undefined ||
  (v.endsAt > v.startsAt && v.endsAt - v.startsAt <= MAX_EVENT_LENGTH_MS);

const createSchema = z
  .object({ serverId: id, ...eventFields })
  .refine(windowIsSane, { message: 'endsAt must be after startsAt and at most 24 h later' });

const updateSchema = z
  .object({
    title: eventFields.title.optional(),
    description: eventFields.description,
    gameTag: eventFields.gameTag,
    startsAt: epochMs.optional(),
    endsAt: epochMs.optional(),
    hostId: eventFields.hostId,
    roles: eventFields.roles.optional(),
    maxParticipants: eventFields.maxParticipants,
    announceChannelId: eventFields.announceChannelId
  })
  .refine(windowIsSane, { message: 'endsAt must be after startsAt and at most 24 h later' });

const createEventActions = (
  pluginId: string,
  loadQueries: TEventQueriesLoader = defaultLoader
): PluginContext['actions']['events'] => {
  const actor: TEventActor = { kind: 'plugin', pluginId };

  const queries = async (): Promise<TEventQueries> => {
    let loaded: Partial<TEventQueries>;

    try {
      loaded = await loadQueries();
    } catch {
      loaded = {};
    }

    if (
      typeof loaded.createEvent !== 'function' ||
      typeof loaded.updateEvent !== 'function' ||
      typeof loaded.cancelEvent !== 'function'
    ) {
      throw new PluginActionError(
        'UNAVAILABLE',
        'Scheduled events are not available on this server'
      );
    }

    return loaded as TEventQueries;
  };

  // The ICS feed caches its render per server; a plugin's change must
  // show on the next pull like a member's does. Loaded lazily for the
  // same reason the queries are.
  const refreshFeed = async (serverId: number) => {
    try {
      const { invalidateFeedCache } = await import('../../http/events-ics');
      invalidateFeedCache(serverId);
    } catch {
      // The feed module is absent in some builds; the render TTL bounds staleness.
    }
  };

  // Same gate as the events router: a community that switched the
  // Planner off refuses plugin-made changes too. Checked after input
  // validation so a malformed call is still a BAD_REQUEST.
  const requireEnabled = async (
    loaded: TEventQueries,
    serverId: number | undefined
  ) => {
    if (serverId === undefined || !loaded.isEventsEnabled) return;

    if (!(await loaded.isEventsEnabled(serverId))) {
      throw new PluginActionError('FORBIDDEN', PLANNER_OFF_MESSAGE);
    }
  };

  const create: PluginContext['actions']['events']['create'] = async (
    rawInput
  ) => {
    const input = parseActionInput(createSchema, rawInput);
    const loaded = await queries();
    await requireEnabled(loaded, input.serverId);

    const event = await loaded.createEvent({ ...input, hostId: input.hostId ?? null, actor });
    await refreshFeed(event.serverId);

    return event;
  };

  const update: PluginContext['actions']['events']['update'] = async (
    rawEventId,
    rawPatch
  ) => {
    const eventId = parseActionInput(id, rawEventId);
    const patch = parseActionInput(updateSchema, rawPatch);
    const loaded = await queries();
    const before = await loaded.getEventById?.(eventId);
    await requireEnabled(loaded, before?.serverId);

    const event = await loaded.updateEvent(eventId, patch, actor);
    await refreshFeed(event.serverId);

    return event;
  };

  const cancel: PluginContext['actions']['events']['cancel'] = async (
    rawEventId
  ) => {
    const eventId = parseActionInput(id, rawEventId);
    const loaded = await queries();
    const before = await loaded.getEventById?.(eventId);
    await requireEnabled(loaded, before?.serverId);

    await loaded.cancelEvent(eventId, actor);
    if (before) await refreshFeed(before.serverId);
  };

  return { create, update, cancel };
};

export { createEventActions };
export type { TEventQueries, TEventQueriesLoader };
