import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '..';
import { channels, serverMembers } from '../schema';

/**
 * Re-key the signed attachment URLs of private channels. Every file
 * token is an HMAC over the channel's `fileAccessToken`, so a new salt
 * invalidates every URL minted before it — the way a member who lost
 * access (kick, ban, leave, a role or override change, the channel
 * flipping private) loses the attachment links they still hold, instead
 * of keeping them until the 24 h token expiry.
 *
 * Called with a `channelId` it re-keys that one channel whether or not
 * it is private (the private→public flip hands it a channel that is
 * already public); without one, every private channel of the server in
 * ONE statement. The salt is generated per row in SQL because the
 * column is unique — a single JS value would collide across rows.
 *
 * Clients that still hold the channel open keep their pre-rotation
 * URLs until the next projection (messages are re-fetched on channel
 * open; images already rendered stay rendered). Acceptable: the goal is
 * that nothing a removed member saved keeps resolving, not that live
 * viewers never see a broken image.
 */
const rotateFileAccessTokens = async (opts: {
  serverId: number;
  channelId?: number;
}): Promise<void> => {
  await db
    .update(channels)
    .set({
      fileAccessToken: sql`gen_random_uuid()::text`,
      fileAccessTokenUpdatedAt: Date.now()
    })
    .where(
      and(
        eq(channels.serverId, opts.serverId),
        opts.channelId === undefined
          ? eq(channels.private, true)
          : eq(channels.id, opts.channelId)
      )
    );
};

/**
 * Bans and account deletion cut a user off everywhere at once: re-key
 * the private channels of every server they are (still) a member of.
 * Must run while the membership rows exist.
 */
const rotateFileAccessTokensForUser = async (userId: number): Promise<void> => {
  await db
    .update(channels)
    .set({
      fileAccessToken: sql`gen_random_uuid()::text`,
      fileAccessTokenUpdatedAt: Date.now()
    })
    .where(
      and(
        eq(channels.private, true),
        inArray(
          channels.serverId,
          db
            .select({ serverId: serverMembers.serverId })
            .from(serverMembers)
            .where(eq(serverMembers.userId, userId))
        )
      )
    );
};

export { rotateFileAccessTokens, rotateFileAccessTokensForUser };
