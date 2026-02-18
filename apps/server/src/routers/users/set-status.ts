import { UserStatus } from '@pulse/shared';
import { z } from 'zod';
import { publishUser } from '../../db/publishers';
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

    // Broadcast the status change to all connected users
    publishUser(ctx.userId, 'update');
  });

export { setStatusRoute };
