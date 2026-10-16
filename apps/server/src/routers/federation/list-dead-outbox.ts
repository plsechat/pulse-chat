import z from 'zod';
import {
  getFederationInstanceById,
  listDeadOutboxRows
} from '../../db/queries/federation';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Dead-lettered relays for one peer, for the federation panel: path,
 * attempt count and the reason (`unsupported:<path>` for a peer that
 * lacks the route, else the last status/error). Payloads stay server-
 * side — they can carry message content.
 */
const listDeadOutboxRoute = instanceOwnerProcedure
  .input(z.object({ instanceId: z.number().int().positive() }))
  .query(async ({ ctx, input }) => {
    const instance = await getFederationInstanceById(input.instanceId);
    if (!instance) {
      ctx.throwValidationError('instanceId', 'Instance not found');
    }
    return listDeadOutboxRows(input.instanceId);
  });

export { listDeadOutboxRoute };
