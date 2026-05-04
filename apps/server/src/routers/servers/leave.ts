import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { publishUser } from '../../db/publishers';
import { getServerById, removeServerMember } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const leaveServerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number()
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

    await removeServerMember(input.serverId, ctx.userId);

    ctx.pubsub.publishFor(ctx.userId, ServerEvents.SERVER_MEMBER_LEAVE, {
      serverId: input.serverId,
      userId: ctx.userId
    });

    // Notify remaining server members so the leaving user disappears from
    // their roster in real time (no more "stale until refresh").
    publishUser(ctx.userId, 'delete', { scopeServerId: input.serverId });
  });

export { leaveServerRoute };
