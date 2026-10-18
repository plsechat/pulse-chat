import { Permission } from '@pulse/shared';
import z from 'zod';
import { isServerMember } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { banServerMember } from '../../utils/server-moderation';
import { serverProcedure } from '../../utils/procedures';

const banRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive(),
      reason: z.string().max(256).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.user.id, {
      code: 'BAD_REQUEST',
      message: 'You cannot ban yourself.'
    });

    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    await banServerMember({
      targetUserId: input.userId,
      serverId: ctx.activeServerId,
      reason: input.reason,
      bannedBy: ctx.userId,
      getUserWs: ctx.getUserWs
    });
  });

export { banRoute };
