import { Permission } from '@pulse/shared';
import z from 'zod';
import { isServerMember } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { banServerMember } from '../../utils/server-moderation';
import { protectedProcedure } from '../../utils/trpc';

const banRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      reason: z.string().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(input.userId !== ctx.user.id, {
      code: 'BAD_REQUEST',
      message: 'You cannot ban yourself.'
    });

    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId!, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    await banServerMember({
      targetUserId: input.userId,
      serverId: ctx.activeServerId!,
      reason: input.reason,
      bannedBy: ctx.userId,
      getUserWs: ctx.getUserWs
    });
  });

export { banRoute };
