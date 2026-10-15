import { ChannelType, Permission } from '@pulse/shared';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, files, webhooks } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * A webhook avatar must be an image file the caller uploaded themselves
 * (plaintext — E2EE uploads carry placeholder metadata and can't be
 * served as an avatar). Rejects with NOT_FOUND for anyone else's file
 * so the id space isn't probeable, and BAD_REQUEST for a non-image.
 * The MIME type is the one file-manager sniffed from the bytes at
 * upload, not a client claim.
 */
const assertWebhookAvatarFile = async (fileId: number, userId: number) => {
  const [file] = await db
    .select({
      mimeType: files.mimeType,
      encrypted: files.encrypted
    })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .limit(1);

  invariant(file, {
    code: 'NOT_FOUND',
    message: 'Avatar file not found'
  });

  invariant(!file.encrypted && file.mimeType.startsWith('image/'), {
    code: 'BAD_REQUEST',
    message: 'Webhook avatar must be an image'
  });
};

const createWebhookRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(80),
      channelId: z.number().int().positive(),
      avatarFileId: z.number().int().positive().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_WEBHOOKS);

    // Verify the channel belongs to the caller's active server
    const [channel] = await db
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId!)
        )
      )
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    // Voice channels have no chat — a webhook pointed at one could still
    // inject messages, so reject at creation.
    invariant(channel.type !== ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Webhooks cannot target voice channels'
    });

    if (input.avatarFileId !== undefined) {
      await assertWebhookAvatarFile(input.avatarFileId, ctx.userId);
    }

    const [webhook] = await db
      .insert(webhooks)
      .values({
        name: input.name,
        channelId: input.channelId,
        token: randomUUID(),
        avatarFileId: input.avatarFileId ?? null,
        createdBy: ctx.userId,
        serverId: ctx.activeServerId!,
        createdAt: Date.now()
      })
      .returning();

    return webhook;
  });

export { assertWebhookAvatarFile, createWebhookRoute };
