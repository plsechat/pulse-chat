import { z } from 'zod';
import { executeAccountDeletion } from '../../utils/account-deletion';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Admin-forced account deletion — the same anonymize-tombstone core as
 * self-service deletion (utils/account-deletion.ts), on the operator's
 * authority instead of a password challenge. The core still refuses
 * federated shadows and accounts that own servers (transfer or delete
 * the server first), and the operator cannot target themselves — use
 * the self-service flow, which owner-blocks anyway (the instance owner
 * owns the bootstrap server by definition).
 */
const deleteUserRoute = instanceOwnerProcedure
  .input(
    z.object({
      userId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot delete your own account from the admin panel.'
    });

    await executeAccountDeletion(input.userId, ctx.getUserWs);
  });

export { deleteUserRoute };
