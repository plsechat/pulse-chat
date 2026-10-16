import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { files, servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getSettingsRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .query(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_SETTINGS, input.serverId);

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .limit(1);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    const logo = server.logoId
      ? (
          await db
            .select()
            .from(files)
            .where(eq(files.id, server.logoId))
            .limit(1)
        )[0]
      : undefined;

    return {
      name: server.name,
      description: server.description,
      password: server.password,
      allowNewUsers: server.allowNewUsers,
      enablePlugins: server.enablePlugins,
      storageUploadEnabled: server.storageUploadEnabled,
      storageQuota: server.storageQuota,
      storageUploadMaxFileSize: server.storageUploadMaxFileSize,
      storageSpaceQuotaByUser: server.storageSpaceQuotaByUser,
      storageOverflowAction: server.storageOverflowAction,
      discoverable: server.discoverable,
      federatable: server.federatable,
      logo: logo ?? null
    };
  });

export { getSettingsRoute };
