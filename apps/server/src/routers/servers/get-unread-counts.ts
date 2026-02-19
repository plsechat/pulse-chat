import { getServerUnreadCounts } from '../../db/queries/servers';
import { protectedProcedure } from '../../utils/trpc';

const getUnreadCountsRoute = protectedProcedure.query(async ({ ctx }) => {
  return getServerUnreadCounts(ctx.userId);
});

export { getUnreadCountsRoute };
