import { getEventDetail } from '../../db/queries/events';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { eventIdInput } from './_shared';

const getEventRoute = serverProcedure()
  .input(eventIdInput)
  .query(async ({ ctx, input }) => {
    const detail = await getEventDetail(input.eventId, ctx.activeServerId);

    invariant(detail, { code: 'NOT_FOUND', message: 'Event not found' });

    return detail;
  });

export { getEventRoute };
