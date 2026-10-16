import z from 'zod';
import { getFederationInstanceById } from '../../db/queries/federation';
import { logger } from '../../logger';
import {
  drainFederationOutbox,
  retryDeadOutboxRows
} from '../../utils/federation-outbox';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Put a peer's dead-lettered relays back on the schedule. The owner
 * reaches for this after the peer upgraded (rows dead on
 * `unsupported:<path>`) or came back from a long outage (rows that
 * exhausted their attempts). A drain pass is kicked right away so the
 * owner sees the result within seconds instead of at the next tick;
 * it runs unlocked here because the cron's lock only guards against
 * overlapping ticks, and a concurrent tick claiming the same row loses
 * the conditional claim cleanly.
 */
const retryOutboxRoute = instanceOwnerProcedure
  .input(z.object({ instanceId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const instance = await getFederationInstanceById(input.instanceId);
    if (!instance) {
      ctx.throwValidationError('instanceId', 'Instance not found');
    }

    const revived = await retryDeadOutboxRows(input.instanceId);
    if (revived > 0) {
      drainFederationOutbox().catch((err) =>
        logger.error('[federation/retryOutbox] drain failed: %o', err)
      );
    }
    return { revived };
  });

export { retryOutboxRoute };
