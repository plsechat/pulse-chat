import { ActivityLogType, DisconnectCode, Permission } from '@pulse/shared';
import z from 'zod';
import { publishUser } from '../../db/publishers';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
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

    const userWs = ctx.getUserWs(input.userId);

    invariant(userWs, {
      code: 'NOT_FOUND',
      message: 'User is not connected'
    });

    userWs.close(DisconnectCode.KICKED, input.reason);

    // Notify other members to remove the user from member list
    publishUser(input.userId, 'delete');

    enqueueActivityLog({
      type: ActivityLogType.USER_KICKED,
      userId: input.userId,
      details: {
        reason: input.reason,
        kickedBy: ctx.userId
      }
    });
  });

export { kickRoute };
