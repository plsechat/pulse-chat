import { withdrawFromEvent } from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';
import { eventIdInput, requireEvent } from './_shared';

const withdrawRoute = serverProcedure()
  .input(eventIdInput)
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    return withdrawFromEvent(event.id, ctx.userId);
  });

export { withdrawRoute };
