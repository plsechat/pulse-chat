import { Permission } from '@pulse/shared';
import { z } from 'zod';
import type { TEvent } from '../../types';
import type { Context } from '../../utils/trpc';
import { getEventForServer } from '../../db/queries/events';
import { invariant } from '../../utils/invariant';

const eventIdInput = z.object({ eventId: z.number().int().positive() });

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

export { eventIdInput, requireEvent, requireHostOrManager };
