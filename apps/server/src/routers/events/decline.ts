import { declineEvent } from '../../db/queries/events';
import { eventsProcedure, eventIdInput, requireEvent } from './_shared';

const declineRoute = eventsProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    return declineEvent(event.id, ctx.userId);
  });

export { declineRoute };
