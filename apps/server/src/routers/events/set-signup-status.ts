import { z } from 'zod';
import { setSignupStatus } from '../../db/queries/events';
import { eventsProcedure, eventIdInput, requireEvent, requireHostOrManager } from './_shared';

const setSignupStatusRoute = eventsProcedure()
  .input(
    eventIdInput.extend({
      userId: z.number().int().positive(),
      status: z.enum(['confirmed', 'bench']),
      roleKey: z.string().min(1).max(24).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const event = await requireEvent(input.eventId, ctx.activeServerId);

    await requireHostOrManager(ctx, event);

    return setSignupStatus(event.id, input.userId, input.status, input.roleKey);
  });

export { setSignupStatusRoute };
