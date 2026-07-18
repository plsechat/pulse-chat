import { getDmChannelsForUser } from '../../db/queries/dms';
import { protectedProcedure } from '../../utils/trpc';
import { attachMemberStatus } from './attach-member-status';

const getChannelsRoute = protectedProcedure.query(async ({ ctx }) => {
  const channels = await getDmChannelsForUser(ctx.userId);
  return attachMemberStatus(channels, ctx);
});

export { getChannelsRoute };
