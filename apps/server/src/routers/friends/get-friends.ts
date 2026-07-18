import { getFriends } from '../../db/queries/friends';
import { protectedProcedure } from '../../utils/trpc';

const getFriendsRoute = protectedProcedure.query(async ({ ctx }) => {
  // Attach the runtime presence rider — mirrors the roster projection
  // in others/get-server-members. Without it the friends list (the
  // client's status fallback for every DM surface) loads permanently
  // status-less and renders everyone offline.
  const friends = await getFriends(ctx.userId);
  return friends.map((friend) => ({
    ...friend,
    status: ctx.getStatusById(friend.id)
  }));
});

export { getFriendsRoute };
