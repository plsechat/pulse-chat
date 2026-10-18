import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import {
  eventFieldsSchema,
  eventRolesSchema,
  updateEvent
} from '../../db/queries/events';
import { invalidateFeedCache } from '../../http/events-ics';
import { invariant } from '../../utils/invariant';
import { eventsProcedure, eventIdInput, requireEvent, requireHostOrManager } from './_shared';

const updateEventRoute = eventsProcedure()
  .input(
    eventIdInput.extend(
      eventFieldsSchema.partial().extend({
        templateId: z.number().int().positive().nullable().optional(),
        roles: eventRolesSchema.optional()
      }).shape
    )
  )
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    await requireHostOrManager(ctx, event);

    if (input.announceChannelId) {
      invariant(
        await ctx.hasChannelPermission(
          input.announceChannelId,
          ChannelPermission.VIEW_CHANNEL
        ),
        { code: 'NOT_FOUND', message: 'Channel not found' }
      );
    }

    const { eventId, ...patch } = input;
    const updated = await updateEvent(eventId, patch, { kind: 'user', userId: ctx.userId });

    invalidateFeedCache(ctx.activeServerId);

    return updated;
  });

export { updateEventRoute };
