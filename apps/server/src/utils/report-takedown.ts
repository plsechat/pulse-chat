import { ServerEvents } from '@pulse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { tombstoneDmMessage, tombstoneMessages } from '../db/mutations/messages';
import { publishMessage } from '../db/publishers';
import { getDmChannelMemberIds } from '../db/queries/dms';
import { dmMessages, messages } from '../db/schema';
import { eventBus } from '../plugins/event-bus';
import { relayAnnouncementDeletion } from './announcement-follow';
import type { Context } from './trpc';

/**
 * Takedown core shared by the operator and server-mod resolvers.
 * Mirrors the regular deletion routes exactly (the same tombstone, the
 * same fan-out events), so clients can't tell a moderation takedown
 * from an author delete — except through the tombstone's `deletedBy`,
 * which names the resolving moderator so MANAGE_MESSAGES holders see
 * who took it down. If the reported message is already gone or already
 * a tombstone (the author deleted it first), this is a no-op and the
 * resolution degrades to a plain resolve.
 */
const takeDownReportedContent = async (
  report: { targetMessageId: number | null; targetDmMessageId: number | null },
  moderatorId: number,
  pubsub: Context['pubsub']
): Promise<void> => {
  if (report.targetMessageId !== null) {
    const [msg] = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(
        and(eq(messages.id, report.targetMessageId), isNull(messages.deletedAt))
      )
      .limit(1);

    if (msg) {
      const deletedAt = Date.now();
      await tombstoneMessages([msg.id], moderatorId, deletedAt);
      const tombstone = { deletedAt, deletedBy: moderatorId };
      publishMessage(msg.id, msg.channelId, 'delete', tombstone);
      void relayAnnouncementDeletion(msg.channelId, [msg.id], tombstone);
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
      .where(
        and(
          eq(dmMessages.id, report.targetDmMessageId),
          isNull(dmMessages.deletedAt)
        )
      )
      .limit(1);

    if (msg) {
      const deletedAt = Date.now();
      await tombstoneDmMessage(msg.id, moderatorId, deletedAt);

      const memberIds = await getDmChannelMemberIds(msg.dmChannelId);
      for (const memberId of memberIds) {
        pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_DELETE, {
          dmMessageId: msg.id,
          dmChannelId: msg.dmChannelId,
          deletedAt,
          deletedBy: moderatorId
        });
      }
    }
  }
};

export { takeDownReportedContent };
