import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { protectedProcedure } from '../../utils/trpc';

const getVisibleUsersRoute = protectedProcedure
  .input(z.object({ channelId: z.number() }))
  .query(async ({ input, ctx }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const userIds = await getAffectedUserIdsForChannel(input.channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });

    return userIds;
  });

export { getVisibleUsersRoute };
