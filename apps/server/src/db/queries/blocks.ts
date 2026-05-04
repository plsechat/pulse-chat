import { and, eq, or } from 'drizzle-orm';
import { db } from '..';
import { userBlocks } from '../schema';
import { getPublicUserById } from './users';
import type { TJoinedPublicUser } from '@pulse/shared';

/**
 * IDs of every user blocker has blocked.
 *
 * Used to filter outbound DMs / pubsub from the *blocker's* side.
 */
const getBlockedUserIds = async (blockerId: number): Promise<Set<number>> => {
  const rows = await db
    .select({ id: userBlocks.blockedUserId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, blockerId));
  return new Set(rows.map((r) => r.id));
};

/**
 * IDs of every user who has blocked targetId.
 *
 * Mirror of getBlockedUserIds — used to filter inbound DMs to targetId
 * (don't deliver messages from anyone who has blocked them) and to
 * refuse friend requests / DM creation initiated by a user the target
 * has blocked.
 */
const getBlockedByUserIds = async (
  targetId: number
): Promise<Set<number>> => {
  const rows = await db
    .select({ id: userBlocks.blockerId })
    .from(userBlocks)
    .where(eq(userBlocks.blockedUserId, targetId));
  return new Set(rows.map((r) => r.id));
};

/**
 * Symmetric "are these two users mutually invisible to each other?"
 * Returns true if either user has blocked the other.
 */
const isBlockBetween = async (
  userA: number,
  userB: number
): Promise<boolean> => {
  const [row] = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      or(
        and(
          eq(userBlocks.blockerId, userA),
          eq(userBlocks.blockedUserId, userB)
        ),
        and(
          eq(userBlocks.blockerId, userB),
          eq(userBlocks.blockedUserId, userA)
        )
      )
    )
    .limit(1);
  return !!row;
};

/**
 * Joined view of every user blocker has blocked, for the
 * client-side blocked-list UI.
 */
const getBlockedUsers = async (
  blockerId: number
): Promise<TJoinedPublicUser[]> => {
  const rows = await db
    .select({ id: userBlocks.blockedUserId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, blockerId));

  const out: TJoinedPublicUser[] = [];
  for (const row of rows) {
    const user = await getPublicUserById(row.id);
    if (user) out.push(user);
  }
  return out;
};

const addBlock = async (
  blockerId: number,
  blockedUserId: number
): Promise<void> => {
  await db
    .insert(userBlocks)
    .values({
      blockerId,
      blockedUserId,
      createdAt: Date.now()
    })
    .onConflictDoNothing({ target: [userBlocks.blockerId, userBlocks.blockedUserId] });
};

const removeBlock = async (
  blockerId: number,
  blockedUserId: number
): Promise<void> => {
  await db
    .delete(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedUserId, blockedUserId)
      )
    );
};

export {
  addBlock,
  getBlockedByUserIds,
  getBlockedUserIds,
  getBlockedUsers,
  isBlockBetween,
  removeBlock
};
