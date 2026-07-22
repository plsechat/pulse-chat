import { ActivityLogType } from '@pulse/shared';
import { z } from 'zod';
import { getServerById } from '../../db/queries/servers';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { deleteServerCore } from '../../utils/server-deletion';

/**
 * Operator server takedown — same core as the owner's delete (the
 * bootstrap-server guard lives there). The audit row carries the
 * server's name/publicId in details because the activity_log serverId
 * FK would cascade away with the server itself.
 */
const deleteServerAdminRoute = instanceOwnerProcedure
  .input(z.object({ serverId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const server = await getServerById(input.serverId);
    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    await deleteServerCore(input.serverId);

    enqueueActivityLog({
      type: ActivityLogType.SERVER_DELETED,
      userId: ctx.userId,
      details: {
        serverId: input.serverId,
        serverName: server.name,
        serverPublicId: server.publicId,
        deletedBy: ctx.userId
      }
    });
  });

export { deleteServerAdminRoute };
