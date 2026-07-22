import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getDmChannelMemberIds } from '../db/queries/dms';
import { channels, dmMessages, messages, users } from '../db/schema';
import { invariant } from './invariant';

type TForwardSourceInput = {
  sourceKind: 'channel' | 'dm';
  sourceId: number;
};

type TForwardAttribution = {
  forwardedFromUserId: number;
  forwardedFromName: string;
};

/**
 * Server-side verification core for forward attribution: loads the
 * SOURCE message the forwarder claims to be forwarding, verifies they
 * can actually see it, and derives the attribution from the stored
 * row — the client never gets to claim who wrote something. An
 * out-of-scope source reads as nonexistent (no cross-server oracle,
 * same rule as everywhere else).
 *
 * Visibility rules match the codebase's message-referencing precedent
 * (edit-message's in-active-server check): a channel source must live
 * in the caller's ACTIVE server; a DM source requires membership in
 * that DM channel.
 */
const resolveForwardSource = async (
  input: TForwardSourceInput,
  ctx: { userId: number; activeServerId: number | undefined }
): Promise<TForwardAttribution> => {
  let authorId: number;

  if (input.sourceKind === 'channel') {
    const [row] = await db
      .select({ userId: messages.userId, serverId: channels.serverId })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(eq(messages.id, input.sourceId))
      .limit(1);

    invariant(row && row.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Source message not found'
    });
    authorId = row.userId;
  } else {
    const [row] = await db
      .select({ userId: dmMessages.userId, dmChannelId: dmMessages.dmChannelId })
      .from(dmMessages)
      .where(eq(dmMessages.id, input.sourceId))
      .limit(1);

    const memberIds = row ? await getDmChannelMemberIds(row.dmChannelId) : [];
    invariant(row && memberIds.includes(ctx.userId), {
      code: 'NOT_FOUND',
      message: 'Source message not found'
    });
    authorId = row.userId;
  }

  const [author] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, authorId))
    .limit(1);

  return {
    forwardedFromUserId: authorId,
    forwardedFromName: author?.name ?? 'Unknown'
  };
};

export { resolveForwardSource };
export type { TForwardSourceInput };
