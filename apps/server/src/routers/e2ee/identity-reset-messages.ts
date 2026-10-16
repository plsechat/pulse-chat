import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../db';
import { logger } from '../../logger';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { pubsub } from '../../utils/pubsub';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  messages
} from '../../db/schema';

/**
 * Ids of the E2EE DM channels `userId` is a member of — one join, no
 * per-row flag lookup.
 */
const getE2eeDmChannelIds = async (userId: number): Promise<number[]> => {
  const rows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .innerJoin(dmChannels, eq(dmChannels.id, dmChannelMembers.dmChannelId))
    .where(
      and(eq(dmChannelMembers.userId, userId), eq(dmChannels.e2ee, true))
    );
  return rows.map((r) => r.dmChannelId);
};

/**
 * Insert an `identity_reset` system row into every E2EE channel the
 * resetting user can view (`channelIds`, from getViewableE2eeChannelIds)
 * and every E2EE DM they are a member of, so peers see why the next
 * messages arrive under a new key.
 */
export async function insertIdentityResetMessages(
  userId: number,
  channelIds: number[]
): Promise<void> {
  const now = Date.now();

  for (const channelId of channelIds) {
    try {
      const [msg] = await db
        .insert(messages)
        .values({
          channelId,
          userId,
          content: 'identity_reset',
          type: 'system',
          e2ee: false,
          editable: false,
          createdAt: now
        })
        .returning();

      if (msg) {
        publishMessage(msg.id, channelId, 'create');
      }
    } catch (err) {
      logger.error(
        `[E2EE] Failed to insert identity reset message for channel ${channelId}:`,
        err
      );
    }
  }

  const dmChannelIds = await getE2eeDmChannelIds(userId);

  logger.info(
    `[E2EE] Identity reset for user ${userId}: inserting system messages into ${channelIds.length} channel(s) and ${dmChannelIds.length} DM channel(s)`
  );

  for (const dmChannelId of dmChannelIds) {
    try {
      const [msg] = await db
        .insert(dmMessages)
        .values({
          dmChannelId,
          userId,
          content: 'identity_reset',
          type: 'system',
          e2ee: false,
          createdAt: now
        })
        .returning();

      if (msg) {
        const joined = await getDmMessage(msg.id);
        if (joined) {
          const memberIds = await getDmChannelMemberIds(dmChannelId);
          for (const memberId of memberIds) {
            pubsub.publishFor(memberId, ServerEvents.DM_NEW_MESSAGE, joined);
          }
        }
      }
    } catch (err) {
      logger.error(
        `[E2EE] Failed to insert identity reset message for DM channel ${dmChannelId}:`,
        err
      );
    }
  }
}

/**
 * Who must learn that `userId` replaced their identity, and which E2EE
 * channels each of them shares with the resetter: every viewer of one
 * of the resetter's E2EE channels (`channelIds`), plus every member of
 * an E2EE DM with them. Those are exactly the users who hold a pairwise
 * session, a TOFU pin or a sender-key chain from the resetter; the old
 * fan-out went to every co-member of every shared server, and each of
 * them then listed ALL their E2EE channels and re-distributed to every
 * one.
 *
 * The channel list is computed per recipient rather than sent whole so
 * the client re-distributes only on channels it actually shares with
 * the resetter — and so one recipient never learns the ids of private
 * channels it cannot see. One viewer query per channel of the resetter
 * is the cost; the resetter's own E2EE channel count is small and a
 * reset is rare. DM-only peers get an empty list: DM chains are re-sent
 * lazily on the next DM send, nothing to re-distribute eagerly.
 */
export async function collectIdentityResetRecipients(
  userId: number,
  channelIds: number[]
): Promise<Map<number, number[]>> {
  const recipients = new Map<number, number[]>();

  for (const channelId of channelIds) {
    const viewerIds = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    for (const viewerId of viewerIds) {
      if (viewerId === userId) continue;
      const shared = recipients.get(viewerId);
      if (shared) shared.push(channelId);
      else recipients.set(viewerId, [channelId]);
    }
  }

  const dmChannelIds = await getE2eeDmChannelIds(userId);
  if (dmChannelIds.length > 0) {
    const peerRows = await db
      .selectDistinct({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(
        and(
          inArray(dmChannelMembers.dmChannelId, dmChannelIds),
          ne(dmChannelMembers.userId, userId)
        )
      );
    for (const { userId: peerId } of peerRows) {
      if (!recipients.has(peerId)) recipients.set(peerId, []);
    }
  }

  return recipients;
}
