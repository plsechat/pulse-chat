import { z } from 'zod';
import { getServerById, isServerOwner } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { deleteServerCore } from '../../utils/server-deletion';
import { protectedProcedure } from '../../utils/trpc';

const deleteServerRoute = protectedProcedure
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

    invariant(await isServerOwner(input.serverId, ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Only the server owner can delete the server'
    });

    await deleteServerCore(input.serverId);
  });

export { deleteServerRoute };
