import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels, messageFiles, messages } from '../../db/schema';
import { relayAnnouncementDeletion } from '../../utils/announcement-follow';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';

const purgeChannelRoute = serverProcedure(Permission.MANAGE_MESSAGES)
  .input(
    z.object({
      channelId: z.number().int().positive(),
      confirmChannelName: z.string().max(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Scope the channel lookup to the caller's active server. Without this,
    // MANAGE_MESSAGES in server A could purge any channel in server B.
    const [channel] = await db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.name === input.confirmChannelName, {
      code: 'BAD_REQUEST',
      message: 'Channel name does not match'
    });

    // Get all file IDs for messages in this channel
    const fileRows = await db
      .select({ fileId: messageFiles.fileId })
      .from(messageFiles)
      .innerJoin(messages, eq(messageFiles.messageId, messages.id))
      .where(eq(messages.channelId, input.channelId));

    for (const row of fileRows) {
      await removeFile(row.fileId);
    }

    // Copies of these in follower channels go too: their ids are only
    // known from the rows being deleted.
    const purged = await db
      .delete(messages)
      .where(eq(messages.channelId, input.channelId))
      .returning({ id: messages.id });
    void relayAnnouncementDeletion(
      input.channelId,
      purged.map((m) => m.id)
    );

    const affectedUserIds = await getAffectedUserIdsForChannel(
      input.channelId,
      { permission: ChannelPermission.VIEW_CHANNEL }
    );
    pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_BULK_DELETE, {
      messageIds: [],
      channelId: input.channelId,
      purged: true
    });

    return { success: true };
  });

export { purgeChannelRoute };
