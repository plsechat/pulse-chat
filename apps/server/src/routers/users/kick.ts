import { Permission } from '@pulse/shared';
import z from 'zod';
import { isServerMember } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { kickFromServer } from '../../utils/server-moderation';
import { protectedProcedure } from '../../utils/trpc';

const kickRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      reason: z.string().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const isMember = await isServerMember(ctx.activeServerId, input.userId);
    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User is not a member of this server'
    });

    await kickFromServer({
      targetUserId: input.userId,
      serverId: ctx.activeServerId,
      reason: input.reason,
      kickedBy: ctx.userId,
      getUserWs: ctx.getUserWs,
      pubsub: ctx.pubsub
    });
  });

export { kickRoute };
