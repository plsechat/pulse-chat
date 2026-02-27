import { StorageOverflowAction } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerById, getServerMemberIds } from '../../db/queries/servers';
import { getServerPublicSettings } from '../../db/queries/server';
import { servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { ServerEvents } from '@pulse/shared';

const updateServerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number(),
      name: z.string().min(2).max(24).optional(),
      description: z.string().max(128).optional(),
      password: z.string().min(1).max(32).optional().nullable(),
      allowNewUsers: z.boolean().optional(),
      storageUploadEnabled: z.boolean().optional(),
      storageUploadMaxFileSize: z.number().min(0).optional(),
      storageSpaceQuotaByUser: z.number().min(0).optional(),
      storageOverflowAction: z.enum(StorageOverflowAction).optional(),
      enablePlugins: z.boolean().optional(),
      discoverable: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: `Server ${input.serverId} not found`
    });

    // Only owner can update server settings
    invariant(server.ownerId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'Only the server owner can update settings'
    });

    const { serverId, ...updates } = input;

    await db
      .update(servers)
      .set({
        ...updates,
        updatedAt: Date.now()
      })
      .where(eq(servers.id, serverId));

    // Publish settings update to all members
    const publicSettings = await getServerPublicSettings(serverId);
    const memberIds = await getServerMemberIds(serverId);
    ctx.pubsub.publishFor(
      memberIds,
      ServerEvents.SERVER_SETTINGS_UPDATE,
      publicSettings
    );
  });

export { updateServerRoute };
