import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { removeFile } from '../db/mutations/files';
import { publishMessage } from '../db/publishers';
import { getDmChannelMemberIds } from '../db/queries/dms';
import { getFilesByMessageId } from '../db/queries/files';
import { dmMessageFiles, dmMessages, messages } from '../db/schema';
import { eventBus } from '../plugins/event-bus';
import type { Context } from './trpc';

/**
 * Takedown core shared by the operator and server-mod resolvers.
 * Mirrors the regular deletion routes exactly (file cleanup + the same
 * fan-out events), so clients can't tell a moderation takedown from an
 * author delete. If the reported message is already gone (author
 * deleted it; the FK went NULL), this is a no-op and the resolution
 * degrades to a plain resolve.
 */
const takeDownReportedContent = async (
  report: { targetMessageId: number | null; targetDmMessageId: number | null },
  pubsub: Context['pubsub']
): Promise<void> => {
  if (report.targetMessageId !== null) {
    const [msg] = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, report.targetMessageId))
      .limit(1);

    if (msg) {
      const files = await getFilesByMessageId(msg.id);
      await Promise.all(files.map((file) => removeFile(file.id)));
      await db.delete(messages).where(eq(messages.id, msg.id));
      publishMessage(msg.id, msg.channelId, 'delete');
      eventBus.emit('message:deleted', {
        channelId: msg.channelId,
        messageId: msg.id
      });
    }
  }

  if (report.targetDmMessageId !== null) {
    const [msg] = await db
      .select({
        id: dmMessages.id,
        dmChannelId: dmMessages.dmChannelId
      })
      .from(dmMessages)
      .where(eq(dmMessages.id, report.targetDmMessageId))
      .limit(1);

    if (msg) {
      const attached = await db
        .select({ fileId: dmMessageFiles.fileId })
        .from(dmMessageFiles)
        .where(eq(dmMessageFiles.dmMessageId, msg.id));
      for (const { fileId } of attached) {
        await removeFile(fileId);
      }
      await db.delete(dmMessages).where(eq(dmMessages.id, msg.id));

      const memberIds = await getDmChannelMemberIds(msg.dmChannelId);
      for (const memberId of memberIds) {
        pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_DELETE, {
          dmMessageId: msg.id,
          dmChannelId: msg.dmChannelId
        });
      }
    }
  }
};

export { takeDownReportedContent };
