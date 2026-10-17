import { declineEvent } from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';
import { eventIdInput, requireEvent } from './_shared';

const declineRoute = serverProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    return declineEvent(event.id, ctx.userId);
  });

export { declineRoute };
