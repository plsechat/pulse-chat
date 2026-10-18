import { Permission } from '@pulse/shared';
import { z } from 'zod';
import type { TEvent } from '../../types';
import type { Context } from '../../utils/trpc';
import { getEventForServer } from '../../db/queries/events';
import { isEventsEnabled } from '../../db/queries/server';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const eventIdInput = z.object({ eventId: z.number().int().positive() });

const PLANNER_OFF_MESSAGE = 'The Planner is turned off in this community';

/** The community's Planner switch (General settings) gates every events surface. */
const requireEventsEnabled = async (serverId: number) => {
  invariant(await isEventsEnabled(serverId), {
    code: 'FORBIDDEN',
    message: PLANNER_OFF_MESSAGE
  });
};

/**
 * serverProcedure plus the Planner switch: every events route of the
 * active server, templates and the calendar link included, refuses
 * while the community has the Planner turned off. Built here so a new
 * route cannot forget the check.
 */
const eventsProcedure = (permission?: Permission | Permission[]) =>
  serverProcedure(permission).use(async ({ ctx, next }) => {
    await requireEventsEnabled(ctx.activeServerId);

    return next();
  });

/** The event by id, scoped to the caller's active server: another server's is "not found". */
const requireEvent = async (
  eventId: number,
  activeServerId: number
): Promise<TEvent> => {
  const event = await getEventForServer(eventId, activeServerId);

  invariant(event, { code: 'NOT_FOUND', message: 'Event not found' });

  return event;
};

/** Edit rights: the host, or anyone holding MANAGE_EVENTS in the server. */
const requireHostOrManager = async (ctx: Context, event: TEvent) => {
  if (event.hostId === ctx.userId) return;

  invariant(await ctx.hasPermission(Permission.MANAGE_EVENTS, event.serverId), {
    code: 'FORBIDDEN',
    message: 'Only the host or an events manager can do that'
  });
};

export {
  eventIdInput,
  eventsProcedure,
  PLANNER_OFF_MESSAGE,
  requireEvent,
  requireEventsEnabled,
  requireHostOrManager
};
