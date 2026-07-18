import type { TJoinedDmChannel } from '@pulse/shared';
import type { Context } from '../../utils/trpc';

/**
 * Attach the runtime presence rider to DM channel member projections.
 * DB queries stay pure by convention (status is derived from live WS
 * connections, not stored) — mirror of the roster projection in
 * others/get-server-members. Without this every DM member loads with
 * status undefined, which the client collapses to OFFLINE.
 */
const attachMemberStatus = (
  channels: TJoinedDmChannel[],
  ctx: Context
): TJoinedDmChannel[] =>
  channels.map((channel) => ({
    ...channel,
    members: channel.members.map((member) => ({
      ...member,
      status: ctx.getStatusById(member.id)
    }))
  }));

export { attachMemberStatus };
