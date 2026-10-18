import { withdrawFromEvent } from '../../db/queries/events';
import { eventsProcedure, eventIdInput, requireEvent } from './_shared';

const withdrawRoute = eventsProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    return withdrawFromEvent(event.id, ctx.userId);
  });

export { withdrawRoute };
