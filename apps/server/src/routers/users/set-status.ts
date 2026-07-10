import { UserStatus } from '@pulse/shared';
import { z } from 'zod';
import { publishUser } from '../../db/publishers';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { protectedProcedure } from '../../utils/trpc';

const setStatusRoute = protectedProcedure
  .input(
    z.object({
      status: z.enum([
        UserStatus.ONLINE,
        UserStatus.IDLE,
        UserStatus.DND,
        UserStatus.INVISIBLE
      ])
    })
  )
  .mutation(async ({ ctx, input }) => {
    ctx.setUserStatus(ctx.userId, input.status);

    // Broadcast the status change to all connected users (include the
    // runtime status since it's not stored in the database)
    publishUser(ctx.userId, 'update', { statusOverride: input.status });

    // Phase E / E3 — push the status change to peer instances that
    // hold a shadow user for me, so federated viewers see online/idle/
    // away in real-time instead of stale state from a prior pull.
    relayUserInfoUpdate(ctx.userId, { status: input.status });
  });

export { setStatusRoute };
