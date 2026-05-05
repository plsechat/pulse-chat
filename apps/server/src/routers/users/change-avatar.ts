import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishUser } from '../../db/publishers';
import { getUserById } from '../../db/queries/users';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const changeAvatarRoute = protectedProcedure
  .input(
    z.object({
      fileId: z.string().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const user = await getUserById(ctx.userId);

    invariant(user, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    if (user.avatarId) {
      await removeFile(user.avatarId);

      await db
        .update(users)
        .set({ avatarId: null })
        .where(eq(users.id, ctx.userId))
        .execute();
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

      const newFile = await fileManager.saveFile(input.fileId, ctx.userId);

      await db
        .update(users)
        .set({ avatarId: newFile.id })
        .where(eq(users.id, ctx.userId))
        .execute();
    }

    publishUser(ctx.userId, 'update');

    // Phase E / E3 — tell peer instances to refresh this user's
    // shadow profile. The new avatar file content can't be sent
    // inline through the dispatch (would bloat federation traffic);
    // instead `triggerProfileSync` makes the receiver re-pull via
    // the existing /federation/user-info GET path, which already
    // handles avatar download via the federated-file pipeline.
    relayUserInfoUpdate(ctx.userId, { triggerProfileSync: true });
  });

export { changeAvatarRoute };
