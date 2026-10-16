import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannels } from '../../db/schema';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const MAX_ICON_BYTES = 3 * 1024 * 1024;

/**
 * Owner-only group DM settings. The icon is set from a temporary
 * upload (same flow as avatars/nameplates): the server saves the temp
 * file itself, so a caller can never point the group at an arbitrary
 * existing `files.id`. `null` clears the icon; omitted leaves it.
 */
const updateGroupRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number().int().positive(),
      name: z.string().trim().max(100).optional(),
      iconTempFileId: z.string().max(64).nullable().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    invariant(channel && channel.isGroup, {
      code: 'NOT_FOUND',
      message: 'Group DM not found'
    });

    invariant(channel.ownerId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'Only the group owner can update the group'
    });

    const updates: Partial<typeof dmChannels.$inferInsert> = {
      updatedAt: Date.now()
    };

    // An empty name falls back to the member-derived default.
    const name = input.name !== undefined ? input.name || null : channel.name;
    if (input.name !== undefined) updates.name = name;

    let iconFileId = channel.iconFileId;

    if (input.iconTempFileId !== undefined) {
      if (input.iconTempFileId === null) {
        iconFileId = null;
      } else {
        const tempFile = fileManager.getTemporaryFile(input.iconTempFileId);

        // Ownership folded into the existence check — no oracle for
        // other users' pending upload ids.
        invariant(tempFile && tempFile.userId === ctx.userId, {
          code: 'NOT_FOUND',
          message: 'Temporary file not found'
        });

        invariant(tempFile.size <= MAX_ICON_BYTES, {
          code: 'BAD_REQUEST',
          message: 'File size exceeds the limit of 3 MB'
        });

        // Bun infers the mime from the temp file's extension — the same
        // source saveFile persists to files.mimeType.
        invariant(Bun.file(tempFile.path).type.startsWith('image/'), {
          code: 'BAD_REQUEST',
          message: 'Group icon must be an image'
        });

        const saved = await fileManager.saveFile(
          input.iconTempFileId,
          ctx.userId
        );
        iconFileId = saved.id;
      }

      updates.iconFileId = iconFileId;
    }

    await db
      .update(dmChannels)
      .set(updates)
      .where(eq(dmChannels.id, input.dmChannelId));

    // The previous icon is referenced by nothing else once the row
    // points elsewhere — drop it instead of waiting for the orphan cron.
    if (channel.iconFileId && channel.iconFileId !== iconFileId) {
      await removeFile(channel.iconFileId);
    }

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    for (const userId of memberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_UPDATE, {
        dmChannelId: input.dmChannelId,
        name,
        iconFileId
      });
    }

    return { name, iconFileId };
  });

export { updateGroupRoute };
