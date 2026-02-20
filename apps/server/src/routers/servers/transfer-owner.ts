import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerById, isServerMember } from '../../db/queries/servers';
import { servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const transferOwnerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number(),
      newOwnerId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    invariant(server.ownerId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'Only the server owner can transfer ownership'
    });

    const targetIsMember = await isServerMember(
      input.serverId,
      input.newOwnerId
    );

    invariant(targetIsMember, {
      code: 'BAD_REQUEST',
      message: 'Target user is not a member of this server'
    });

    await db
      .update(servers)
      .set({
        ownerId: input.newOwnerId,
        updatedAt: Date.now()
      })
      .where(eq(servers.id, input.serverId));

    ctx.invalidatePermissionCache();
  });

export { transferOwnerRoute };
