import { and, eq, or } from 'drizzle-orm';
import { db } from '..';
import { friendRequests, friendships } from '../schema';
import { getPublicUsersByIds } from './users';
import type { TJoinedFriendRequest, TJoinedPublicUser } from '@pulse/shared';

const getFriends = async (userId: number): Promise<TJoinedPublicUser[]> => {
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(eq(friendships.userId, userId), eq(friendships.friendId, userId))
    );

  const friendIds = rows.map((r) =>
    r.userId === userId ? r.friendId : r.userId
  );

  // One batched projection for the whole list (was one 3-query lookup
  // per friend); order follows the friendship rows.
  const usersById = await getPublicUsersByIds(friendIds);
  const friends: TJoinedPublicUser[] = [];

  for (const friendId of friendIds) {
    const user = usersById.get(friendId);
    if (user) friends.push(user);
  }

  return friends;
};

const areFriends = async (
  userId: number,
  friendId: number
): Promise<boolean> => {
  const [row] = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)),
        and(eq(friendships.userId, friendId), eq(friendships.friendId, userId))
      )
    )
    .limit(1);

  return !!row;
};

const getPendingRequests = async (
  userId: number
): Promise<TJoinedFriendRequest[]> => {
  const rows = await db
    .select()
    .from(friendRequests)
    .where(
      and(
        or(
          eq(friendRequests.senderId, userId),
          eq(friendRequests.receiverId, userId)
        ),
        eq(friendRequests.status, 'pending')
      )
    );

  const usersById = await getPublicUsersByIds(
    rows.flatMap((row) => [row.senderId, row.receiverId])
  );
  const joined: TJoinedFriendRequest[] = [];

  for (const row of rows) {
    const sender = usersById.get(row.senderId);
    const receiver = usersById.get(row.receiverId);

    if (sender && receiver) {
      joined.push({ ...row, sender, receiver });
    }
  }

  return joined;
};

const getJoinedFriendRequest = async (
  requestId: number
): Promise<TJoinedFriendRequest | null> => {
  const [row] = await db
    .select()
    .from(friendRequests)
    .where(eq(friendRequests.id, requestId))
    .limit(1);

  if (!row) return null;

  const usersById = await getPublicUsersByIds([row.senderId, row.receiverId]);
  const sender = usersById.get(row.senderId);
  const receiver = usersById.get(row.receiverId);

  if (!sender || !receiver) return null;

  return { ...row, sender, receiver };
};

export { areFriends, getFriends, getJoinedFriendRequest, getPendingRequests };
