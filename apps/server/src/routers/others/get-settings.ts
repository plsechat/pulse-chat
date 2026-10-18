import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { files, servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';

const getSettingsRoute = serverProcedureFor(Permission.MANAGE_SETTINGS).query(
  async ({ input }) => {
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
      enableEvents: server.enableEvents,
      storageUploadEnabled: server.storageUploadEnabled,
      storageQuota: server.storageQuota,
      storageUploadMaxFileSize: server.storageUploadMaxFileSize,
      storageSpaceQuotaByUser: server.storageSpaceQuotaByUser,
      storageOverflowAction: server.storageOverflowAction,
      discoverable: server.discoverable,
      federatable: server.federatable,
      directoryListed: server.directoryListed,
      directoryDescription: server.directoryDescription,
      directoryTags: server.directoryTags ?? [],
      directoryGame: server.directoryGame,
      logo: logo ?? null
    };
  }
);

export { getSettingsRoute };
