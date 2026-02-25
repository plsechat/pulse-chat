import { ChannelPermission, ChannelType, ServerEvents } from '@pulse/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getForumUnreadForUser } from '../../db/queries/channels';
import { getServerUnreadCount } from '../../db/queries/servers';
import { channelReadStates, channels, messages } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const markAsReadRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const { channelId } = input;

    // get the newest message in the channel
    const [newestMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (!newestMessage) {
      return;
    }

    const newestId = newestMessage.id;

    const [existingState] = await db
      .select()
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.channelId, channelId),
          eq(channelReadStates.userId, ctx.userId)
        )
      )
      .limit(1);

    if (existingState) {
      await db
        .update(channelReadStates)
        .set({
          lastReadMessageId: newestId,
          lastReadAt: Date.now()
        })
        .where(
          and(
            eq(channelReadStates.channelId, channelId),
            eq(channelReadStates.userId, ctx.userId)
          )
        );
    } else {
      await db.insert(channelReadStates).values({
        channelId,
        userId: ctx.userId,
        lastReadMessageId: newestId,
        lastReadAt: Date.now()
      });
    }

    // Notify the user that their read state is now clear
    ctx.pubsub.publishFor(ctx.userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
      channelId,
      count: 0,
      mentionCount: 0
    });

    // Publish server-level unread count update
    const [channel] = await db
      .select({
        serverId: channels.serverId,
        type: channels.type,
        parentChannelId: channels.parentChannelId
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (channel) {
      const { unreadCount: serverCount, mentionCount: serverMentionCount } =
        await getServerUnreadCount(ctx.userId, channel.serverId);
      ctx.pubsub.publishFor(
        ctx.userId,
        ServerEvents.SERVER_UNREAD_COUNT_UPDATE,
        { serverId: channel.serverId, count: serverCount, mentionCount: serverMentionCount }
      );

      // If this is a forum thread, also update the parent forum's aggregated unread
      if (channel.type === ChannelType.THREAD && channel.parentChannelId) {
        const [parentInfo] = await db
          .select({ type: channels.type })
          .from(channels)
          .where(eq(channels.id, channel.parentChannelId))
          .limit(1);

        if (parentInfo?.type === ChannelType.FORUM) {
          const { unreadCount, mentionCount } = await getForumUnreadForUser(
            ctx.userId,
            channel.parentChannelId
          );
          ctx.pubsub.publishFor(ctx.userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
            channelId: channel.parentChannelId,
            count: unreadCount,
            mentionCount
          });
        }
      }
    }
  });

export { markAsReadRoute };
