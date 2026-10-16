import { Permission } from '@pulse/shared';
import z from 'zod';
import { isServerMember } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { kickFromServer } from '../../utils/server-moderation';
import { serverProcedure } from '../../utils/procedures';

const kickRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive(),
      reason: z.string().max(256).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot kick yourself.'
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
