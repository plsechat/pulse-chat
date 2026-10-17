import { cancelEvent } from '../../db/queries/events';
import { invalidateFeedCache } from '../../http/events-ics';
import { serverProcedure } from '../../utils/procedures';
import { eventIdInput, requireEvent, requireHostOrManager } from './_shared';

const cancelEventRoute = serverProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    await requireHostOrManager(ctx, event);
    await cancelEvent(event.id, { kind: 'user', userId: ctx.userId });
    invalidateFeedCache(ctx.activeServerId);
  });

export { cancelEventRoute };
