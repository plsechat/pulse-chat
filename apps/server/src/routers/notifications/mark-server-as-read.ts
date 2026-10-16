import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getAllChannelUserPermissions } from '../../db/queries/channels';
import { getServerById, isServerMember } from '../../db/queries/servers';
import { channelReadStates, channels, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const markServerAsReadRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(await isServerMember(input.serverId, ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this server'
    });

    // Only the channels this user can see: read-state rows for channels
    // they have no access to would be a channel-count oracle.
    const [server, serverChannels, permissions] = await Promise.all([
      getServerById(input.serverId),
      db
        .select({ id: channels.id, private: channels.private })
        .from(channels)
        .where(eq(channels.serverId, input.serverId)),
      getAllChannelUserPermissions(ctx.userId, input.serverId)
    ]);

    const isOwner = server?.ownerId === ctx.userId;
    const visibleIds = serverChannels
      .filter(
        (c) =>
          isOwner ||
          (permissions[c.id]?.permissions[ChannelPermission.VIEW_CHANNEL] ??
            !c.private)
      )
      .map((c) => c.id);

    if (visibleIds.length > 0) {
      const now = Date.now();

      // One statement: the newest message of every visible channel,
      // upserted into this user's read state.
      await db
        .insert(channelReadStates)
        .select(
          db
            .select({
              userId: sql<number>`${ctx.userId}`.as('user_id'),
              channelId: messages.channelId,
              lastReadMessageId: sql<number>`max(${messages.id})`.as(
                'last_read_message_id'
              ),
              lastReadAt: sql<number>`${now}`.as('last_read_at')
            })
            .from(messages)
            .where(inArray(messages.channelId, visibleIds))
            .groupBy(messages.channelId)
        )
        .onConflictDoUpdate({
          target: [channelReadStates.userId, channelReadStates.channelId],
          set: {
            lastReadMessageId: sql`excluded.last_read_message_id`,
            lastReadAt: sql`excluded.last_read_at`
          }
        });
    }

    for (const channelId of visibleIds) {
      ctx.pubsub.publishFor(
        ctx.userId,
        ServerEvents.CHANNEL_READ_STATES_UPDATE,
        { channelId, count: 0, mentionCount: 0 }
      );
    }

    ctx.pubsub.publishFor(
      ctx.userId,
      ServerEvents.SERVER_UNREAD_COUNT_UPDATE,
      { serverId: input.serverId, count: 0, mentionCount: 0 }
    );
  });

export { markServerAsReadRoute };
