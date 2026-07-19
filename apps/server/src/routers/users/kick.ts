import { ActivityLogType, DisconnectCode, Permission, ServerEvents } from '@pulse/shared';
import z from 'zod';
import { publishUser } from '../../db/publishers';
import {
  getServerById,
  isServerMember,
  removeServerMember
} from '../../db/queries/servers';
import { enqueueActivityLog } from '../../queues/activity-log';
import { relayFederatedModeration } from '../../utils/federation-moderation-dispatch';
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
      message: 'User is not a member of this server'
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

    // Include the globally-unique publicId so clients can scope the event —
    // the numeric serverId collides across federated instances.
    const server = await getServerById(ctx.activeServerId);

    // Notify the kicked user so their client can show a toast and navigate home
    ctx.pubsub.publishFor(input.userId, ServerEvents.USER_KICKED, {
      serverId: ctx.activeServerId,
      serverPublicId: server?.publicId,
      reason: input.reason
    });

    // Notify the kicked user to remove the server from their joined list
    ctx.pubsub.publishFor(input.userId, ServerEvents.SERVER_MEMBER_LEAVE, {
      serverId: ctx.activeServerId,
      serverPublicId: server?.publicId,
      userId: input.userId
    });

    // Notify the active server's members to drop the user from the roster.
    // Note: this fires AFTER `removeServerMember`, so getServerMemberIds
    // (inside publishUser) returns the remaining members — the kicked user
    // already received USER_KICKED above and doesn't need USER_DELETE.
    publishUser(input.userId, 'delete', { scopeServerId: ctx.activeServerId });

    // Federated member? Tell their home instance so its membership
    // record is removed and the user learns why (fire-and-forget —
    // never blocks or fails local moderation).
    relayFederatedModeration(
      input.userId,
      ctx.activeServerId,
      'kick',
      input.reason
    );

    enqueueActivityLog({
      type: ActivityLogType.USER_KICKED,
      userId: input.userId,
      serverId: ctx.activeServerId,
      details: {
        reason: input.reason,
        kickedBy: ctx.userId
      }
    });
  });

export { kickRoute };
