import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { refuseInPreview } from '../../utils/preview-guard';
import { protectedProcedure } from '../../utils/trpc';

const getVisibleUsersRoute = protectedProcedure
  .input(z.object({ channelId: z.number() }))
  .query(async ({ input, ctx }) => {
    // Read-only, but it enumerates the member list — preview scope is
    // "public channels + messages", not the roster.
    await refuseInPreview(ctx, input.channelId);
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
