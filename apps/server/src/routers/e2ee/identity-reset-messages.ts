import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { pubsub } from '../../utils/pubsub';
import {
  channels,
  dmChannelMembers,
  dmChannels,
  dmMessages,
  messages
} from '../../db/schema';

/**
 * Insert system messages into all E2EE channels and DMs that a user
 * participates in, notifying peers that their encryption keys have changed.
 */
export async function insertIdentityResetMessages(
  userId: number
): Promise<void> {
  const now = Date.now();

  // --- E2EE Channels ---
  const e2eeChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.e2ee, true));

  for (const channel of e2eeChannels) {
    const affectedUserIds = await getAffectedUserIdsForChannel(channel.id, {
      permission: ChannelPermission.VIEW_CHANNEL
    });

    if (!affectedUserIds.includes(userId)) continue;

    const [msg] = await db
      .insert(messages)
      .values({
        channelId: channel.id,
        userId,
        content: 'identity_reset',
        type: 'system',
        e2ee: false,
        editable: false,
        createdAt: now
      })
      .returning();

    if (msg) {
      publishMessage(msg.id, channel.id, 'create');
    }
  }

  // --- E2EE DMs ---
  const userDmRows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, userId));

  for (const row of userDmRows) {
    // Only insert into E2EE DM channels
    const [dmChannel] = await db
      .select({ e2ee: dmChannels.e2ee })
      .from(dmChannels)
      .where(eq(dmChannels.id, row.dmChannelId))
      .limit(1);

    if (!dmChannel?.e2ee) continue;

    const [msg] = await db
      .insert(dmMessages)
      .values({
        dmChannelId: row.dmChannelId,
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
        const memberIds = await getDmChannelMemberIds(row.dmChannelId);
        for (const memberId of memberIds) {
          pubsub.publishFor(memberId, ServerEvents.DM_NEW_MESSAGE, joined);
        }
      }
    }
  }
}
