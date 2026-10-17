import { ChannelPermission, Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  createEvent,
  eventFieldsSchema,
  eventRolesSchema
} from '../../db/queries/events';
import { invalidateFeedCache } from '../../http/events-ics';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const createEventRoute = serverProcedure(Permission.MANAGE_EVENTS)
  .input(
    eventFieldsSchema.extend({
      templateId: z.number().int().positive().optional(),
      roles: eventRolesSchema.optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // The RSVP card is posted into a channel the creator can see; a
    // channel they cannot view is reported like one that does not exist.
    if (input.announceChannelId) {
      invariant(
        await ctx.hasChannelPermission(
          input.announceChannelId,
          ChannelPermission.VIEW_CHANNEL
        ),
        { code: 'NOT_FOUND', message: 'Channel not found' }
      );
    }

    const event = await createEvent({
      serverId: ctx.activeServerId,
      title: input.title,
      description: input.description ?? null,
      gameTag: input.gameTag ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      hostId: ctx.userId,
      templateId: input.templateId ?? null,
      roles: input.roles,
      maxParticipants: input.maxParticipants ?? null,
      announceChannelId: input.announceChannelId ?? null,
      actor: { kind: 'user', userId: ctx.userId }
    });

    // The calendar feed renders afresh on its next poll.
    invalidateFeedCache(ctx.activeServerId);

    return event;
  });

export { createEventRoute };
