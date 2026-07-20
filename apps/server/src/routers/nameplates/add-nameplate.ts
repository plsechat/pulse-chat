import { Permission } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { nameplates } from '../../db/schema';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Upload a custom nameplate pack for the active server. Gated on
 * MANAGE_EMOJIS — the asset-expression admin permission family that
 * custom emojis use.
 */
const addNameplateRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(32),
      tempFileId: z.string().max(64)
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_EMOJIS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const tempFile = await fileManager.getTemporaryFile(input.tempFileId);

    invariant(tempFile, {
      code: 'NOT_FOUND',
      message: 'Temporary file not found'
    });

    invariant(tempFile.size <= 1024 * 1024, {
      code: 'BAD_REQUEST',
      message: 'File size exceeds the limit of 1 MB'
    });

    // Bun infers the mime from the temp file's extension — the same
    // source saveFile persists to files.mimeType.
    invariant(Bun.file(tempFile.path).type.startsWith('image/'), {
      code: 'BAD_REQUEST',
      message: 'Nameplate must be an image'
    });

    const newFile = await fileManager.saveFile(input.tempFileId, ctx.userId);

    const [nameplate] = await db
      .insert(nameplates)
      .values({
        name: input.name,
        fileId: newFile.id,
        serverId: ctx.activeServerId,
        createdAt: Date.now()
      })
      .returning();

    return {
      id: nameplate!.id,
      name: nameplate!.name,
      file: { id: newFile.id, name: newFile.name }
    };
  });

export { addNameplateRoute };
