import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { rotateFileAccessTokens } from '../../db/mutations/channels';
import { publishUser } from '../../db/publishers';
import { getServerById, removeServerMember } from '../../db/queries/servers';
import { eventBus } from '../../plugins/event-bus';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const leaveServerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    // Owner cannot leave — must transfer ownership first
    invariant(server.ownerId !== ctx.userId, {
      code: 'FORBIDDEN',
      message: 'Server owner cannot leave. Transfer ownership first.'
    });

    // Membership, roles and channel overrides go together (see
    // removeServerMember).
    await removeServerMember(input.serverId, ctx.userId);
    // The attachment links they still hold must stop resolving.
    await rotateFileAccessTokens({ serverId: input.serverId });

    // This connection must not keep acting in the server it just left:
    // with the active server unset every permission check denies until
    // the client re-joins another server, and the cached roles / channel
    // overrides from the old server are dropped.
    if (ctx.activeServerId === input.serverId) {
      ctx.activeServerId = undefined;
      ctx.invalidatePermissionCache();
    }

    ctx.pubsub.publishFor(ctx.userId, ServerEvents.SERVER_MEMBER_LEAVE, {
      serverId: input.serverId,
      serverPublicId: server.publicId,
      userId: ctx.userId
    });

    // Notify remaining server members so the leaving user disappears from
    // their roster in real time (no more "stale until refresh").
    publishUser(ctx.userId, 'delete', { scopeServerId: input.serverId });

    eventBus.emit('user:left', {
      userId: ctx.userId,
      username: ctx.user.name,
      serverId: input.serverId
    });
  });

export { leaveServerRoute };
