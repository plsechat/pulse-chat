import { getServerUnreadCounts } from '../../db/queries/servers';
import { protectedProcedure } from '../../utils/trpc';

const getUnreadCountsRoute = protectedProcedure.query(async ({ ctx }) => {
  const { unreadCounts, mentionCounts } = await getServerUnreadCounts(ctx.userId);
  return { unreadCounts, mentionCounts };
});

export { getUnreadCountsRoute };
