import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { removeBlock } from '../../db/queries/blocks';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const unblockRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    await removeBlock(ctx.userId, input.userId);
    pubsub.publishFor(ctx.userId, ServerEvents.USER_BLOCK_CHANGED, {
      blockedUserId: input.userId,
      blocked: false
    });
  });

export { unblockRoute };
