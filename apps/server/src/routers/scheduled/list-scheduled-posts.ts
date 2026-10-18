import { ChannelPermission, Permission } from '@pulse/shared';
import { listPendingScheduledPosts } from '../../db/queries/scheduled-posts';
import { channelProcedure } from '../../utils/procedures';

/**
 * The channel's pending posts: the caller's own, or everyone's for a
 * MANAGE_MESSAGES holder (who can also cancel them).
 */
const listScheduledPostsRoute = channelProcedure(ChannelPermission.VIEW_CHANNEL, {
  preview: 'refuse'
}).query(async ({ ctx }) => {
  const seesAll = await ctx.hasPermission(Permission.MANAGE_MESSAGES, ctx.channel.serverId);

  return listPendingScheduledPosts(ctx.channel.id, seesAll ? undefined : ctx.userId);
});

export { listScheduledPostsRoute };
