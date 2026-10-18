import { getEventDetail } from '../../db/queries/events';
import { invariant } from '../../utils/invariant';
import { eventsProcedure, eventIdInput } from './_shared';

const getEventRoute = eventsProcedure()
  .input(eventIdInput)
  .query(async ({ ctx, input }) => {
    const detail = await getEventDetail(input.eventId, ctx.activeServerId);

    invariant(detail, { code: 'NOT_FOUND', message: 'Event not found' });

    return detail;
  });

export { getEventRoute };
