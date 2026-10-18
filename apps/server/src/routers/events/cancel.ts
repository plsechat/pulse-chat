import { cancelEvent } from '../../db/queries/events';
import { invalidateFeedCache } from '../../http/events-ics';
import { eventsProcedure, eventIdInput, requireEvent, requireHostOrManager } from './_shared';

const cancelEventRoute = eventsProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    await requireHostOrManager(ctx, event);
    await cancelEvent(event.id, { kind: 'user', userId: ctx.userId });
    invalidateFeedCache(ctx.activeServerId);
  });

export { cancelEventRoute };
