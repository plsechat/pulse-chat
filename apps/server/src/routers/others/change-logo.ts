import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { getServerPublicSettings } from '../../db/queries/server';
import { getServerById, getServerMemberIds } from '../../db/queries/servers';
import { servers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { fileManager } from '../../utils/file-manager';
import { serverProcedureFor } from '../../utils/procedures';

const changeLogoRoute = serverProcedureFor(Permission.MANAGE_SETTINGS)
  .input(
    z.object({
      fileId: z.string().max(64).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    if (server.logoId) {
      await removeFile(server.logoId);
      await db
        .update(servers)
        .set({ logoId: null, updatedAt: Date.now() })
        .where(eq(servers.id, input.serverId));
    }

    if (input.fileId) {
      const tempFile = await fileManager.getTemporaryFile(input.fileId);

      invariant(tempFile, {
        code: 'NOT_FOUND',
        message: 'Temporary file not found'
      });

      invariant(tempFile.size <= 3 * 1024 * 1024, {
        code: 'BAD_REQUEST',
        message: 'File size exceeds the limit of 3 MB'
      });

      // Bun infers the mime from the temp file's extension — the same
      // source saveFile persists to files.mimeType.
      invariant(Bun.file(tempFile.path).type.startsWith('image/'), {
        code: 'BAD_REQUEST',
        message: 'Logo must be an image'
      });

      const newFile = await fileManager.saveFile(input.fileId, ctx.userId);

      await db
        .update(servers)
        .set({ logoId: newFile.id, updatedAt: Date.now() })
        .where(eq(servers.id, input.serverId));
    }

    // Publish to server members
    const publicSettings = await getServerPublicSettings(input.serverId);
    const memberIds = await getServerMemberIds(input.serverId);
    ctx.pubsub.publishFor(
      memberIds,
      ServerEvents.SERVER_SETTINGS_UPDATE,
      publicSettings
    );
  });

export { changeLogoRoute };
