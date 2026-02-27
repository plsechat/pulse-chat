import {
  ActivityLogType,
  Permission,
  ServerEvents,
  StorageOverflowAction
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerPublicSettings } from '../../db/queries/server';
import { getServerById, getServerMemberIds } from '../../db/queries/servers';
import { servers } from '../../db/schema';
import { pluginManager } from '../../plugins';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updateSettingsRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number(),
      name: z.string().min(2).max(24).optional(),
      description: z.string().max(128).optional(),
      password: z.string().min(1).max(32).optional().nullable().default(null),
      allowNewUsers: z.boolean().optional(),
      storageUploadEnabled: z.boolean().optional(),
      storageUploadMaxFileSize: z.number().min(0).optional(),
      storageSpaceQuotaByUser: z.number().min(0).optional(),
      storageOverflowAction: z.enum(StorageOverflowAction).optional(),
      enablePlugins: z.boolean().optional(),
      discoverable: z.boolean().optional(),
      federatable: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: `Server ${input.serverId} not found`
    });

    await ctx.needsPermission(Permission.MANAGE_SETTINGS, input.serverId);

    const oldEnablePlugins = server.enablePlugins;
    const { serverId, ...updates } = input;

    await db
      .update(servers)
      .set({
        ...updates,
        updatedAt: Date.now()
      })
      .where(eq(servers.id, serverId));

    if (oldEnablePlugins !== input.enablePlugins) {
      if (input.enablePlugins) {
        await pluginManager.loadPlugins();
      } else {
        await pluginManager.unloadPlugins();
      }
    }

    // Publish to server members
    const publicSettings = await getServerPublicSettings(serverId);
    const memberIds = await getServerMemberIds(serverId);
    ctx.pubsub.publishFor(
      memberIds,
      ServerEvents.SERVER_SETTINGS_UPDATE,
      publicSettings
    );

    enqueueActivityLog({
      type: ActivityLogType.EDIT_SERVER_SETTINGS,
      userId: ctx.userId,
      details: { values: input }
    });
  });

export { updateSettingsRoute };
