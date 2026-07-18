import {
  ActivityLogType,
  Permission,
  ServerEvents,
  StorageOverflowAction
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  isInstanceOwner,
  isServerOwner
} from '../../db/queries/servers';
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
      message: 'Server not found'
    });

    await ctx.needsPermission(Permission.MANAGE_SETTINGS, input.serverId);

    // "Federatable" is owner-controlled and instance-gated, unlike the
    // rest of these MANAGE_SETTINGS fields: only the server OWNER may
    // change it, and turning it ON also requires the instance owner to
    // have allowed user-federatable servers (you being the instance owner
    // always counts). The client submits the whole settings object, so
    // only enforce when the value actually changes — otherwise a non-owner
    // admin editing the name would trip on the unchanged federatable flag.
    if (
      input.federatable !== undefined &&
      input.federatable !== server.federatable
    ) {
      invariant(await isServerOwner(input.serverId, ctx.userId), {
        code: 'FORBIDDEN',
        message:
          'Only the server owner can change whether this server is federatable'
      });

      if (input.federatable === true) {
        const allowed =
          (await isInstanceOwner(ctx.userId)) ||
          config.federation.allowUserFederatableServers;
        invariant(allowed, {
          code: 'FORBIDDEN',
          message:
            'The instance owner has not allowed users to make servers federatable'
        });
      }
    }

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
