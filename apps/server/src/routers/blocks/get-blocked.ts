import { getBlockedUsers } from '../../db/queries/blocks';
import { protectedProcedure } from '../../utils/trpc';

const getBlockedRoute = protectedProcedure.query(async ({ ctx }) => {
  return getBlockedUsers(ctx.userId);
});

export { getBlockedRoute };
