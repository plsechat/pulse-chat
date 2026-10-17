import { z } from 'zod';
import { signupForEvent } from '../../db/queries/events';
import { serverProcedure } from '../../utils/procedures';
import { eventIdInput, requireEvent } from './_shared';

const signupRoute = serverProcedure()
  .input(eventIdInput.extend({ roleKey: z.string().min(1).max(24) }))
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    return signupForEvent(event.id, ctx.userId, input.roleKey);
  });

export { signupRoute };
