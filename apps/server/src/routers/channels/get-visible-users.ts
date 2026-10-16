import { ChannelPermission } from '@pulse/shared';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channelProcedure } from '../../utils/procedures';

// Read-only, but it enumerates the member list — preview scope is
// "public channels + messages", not the roster.
const getVisibleUsersRoute = channelProcedure(ChannelPermission.VIEW_CHANNEL, {
  preview: 'refuse'
}).query(async ({ input }) => {
    const userIds = await getAffectedUserIdsForChannel(input.channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });

    return userIds;
  });

export { getVisibleUsersRoute };
