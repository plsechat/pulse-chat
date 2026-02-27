import { ActivityLogType, DisconnectCode, Permission, ServerEvents } from '@pulse/shared';
import z from 'zod';
import { publishUser } from '../../db/publishers';
import {
  isServerMember,
  removeServerMember
} from '../../db/queries/servers';
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

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const isMember = await isServerMember(ctx.activeServerId, input.userId);
    invariant(isMember, {
      code: 'NOT_FOUND',
      message: `User ${input.userId} is not a member of this server`
    });

    // Close all of the kicked user's WebSocket connections
    const userConnections = ctx.getUserWs(input.userId);
    if (userConnections) {
      for (const ws of userConnections) {
        ws.close(DisconnectCode.KICKED, input.reason);
      }
    }

    // Remove the user from this server (same as leaving)
    await removeServerMember(ctx.activeServerId, input.userId);

    // Notify the kicked user so their client can show a toast and navigate home
    ctx.pubsub.publishFor(input.userId, ServerEvents.USER_KICKED, {
      serverId: ctx.activeServerId,
      reason: input.reason
    });

    // Notify the kicked user to remove the server from their joined list
    ctx.pubsub.publishFor(input.userId, ServerEvents.SERVER_MEMBER_LEAVE, {
      serverId: ctx.activeServerId,
      userId: input.userId
    });

    // Notify other members to remove the user from the member list
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
