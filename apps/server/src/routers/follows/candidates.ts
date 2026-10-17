import { ChannelPermission, ChannelType, Permission } from '@pulse/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { getAllChannelUserPermissions } from '../../db/queries/channels';
import { channels, serverMembers, servers } from '../../db/schema';
import type { TFollowSourceCandidate } from '../../types';
import { serverProcedure } from '../../utils/procedures';

/**
 * Announcement channels the caller may follow from a channel of the
 * active server: every announcement TEXT channel in a server they are a
 * member of on this instance that they can view there. Channel
 * permissions are evaluated per server with the same precedence as
 * the connection's own (owner bypass, overrides, public default).
 */
const followCandidatesRoute = serverProcedure(Permission.MANAGE_CHANNELS).query(
  async ({ ctx }): Promise<TFollowSourceCandidate[]> => {
    const memberships = await db
      .select({ id: servers.id, name: servers.name, ownerId: servers.ownerId })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, ctx.userId));

    if (memberships.length === 0) return [];

    const announcementChannels = await db
      .select({
        id: channels.id,
        name: channels.name,
        serverId: channels.serverId,
        private: channels.private
      })
      .from(channels)
      .where(
        and(
          inArray(
            channels.serverId,
            memberships.map((m) => m.id)
          ),
          eq(channels.type, ChannelType.TEXT),
          eq(channels.announcement, true)
        )
      )
      .orderBy(channels.serverId, channels.position);

    const out: TFollowSourceCandidate[] = [];

    for (const server of memberships) {
      const mine = announcementChannels.filter((c) => c.serverId === server.id);
      if (mine.length === 0) continue;

      const isOwner = server.ownerId === ctx.userId;
      const perms = isOwner ? null : await getAllChannelUserPermissions(ctx.userId, server.id);

      for (const channel of mine) {
        const visible =
          isOwner || perms?.[channel.id]?.permissions[ChannelPermission.VIEW_CHANNEL] === true;
        if (!visible) continue;
        out.push({
          serverId: server.id,
          serverName: server.name,
          channelId: channel.id,
          channelName: channel.name
        });
      }
    }

    return out;
  }
);

export { followCandidatesRoute };
