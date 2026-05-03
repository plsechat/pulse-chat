import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteThreadRoute = protectedProcedure
  .input(z.object({ threadId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [thread] = await db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        serverId: channels.serverId,
        parentChannelId: channels.parentChannelId
      })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.threadId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!thread || thread.type !== ChannelType.THREAD) {
      return ctx.throwValidationError('threadId', 'Thread not found');
    }

    const hasManagePermission = await ctx.hasPermission(
      Permission.MANAGE_CHANNELS,
      thread.serverId
    );

    if (!hasManagePermission) {
      // Determine the thread creator. Two thread shapes exist:
      //  - Forum threads (create-forum-post): the post-content message
      //    sits inside the thread channel as the first message.
      //  - Inline threads (create-thread): the source message stays in
      //    the parent channel with messages.thread_id pointing here, so
      //    the thread channel itself can have zero messages.
      // Try the source-message lookup first, then fall back to the
      // earliest message in the thread channel for forum threads.
      const [sourceMessage] = await db
        .select({ userId: messages.userId })
        .from(messages)
        .where(eq(messages.threadId, input.threadId))
        .limit(1);

      let creatorId = sourceMessage?.userId;

      if (creatorId === undefined) {
        const [firstThreadMessage] = await db
          .select({ userId: messages.userId })
          .from(messages)
          .where(eq(messages.channelId, input.threadId))
          .orderBy(asc(messages.createdAt))
          .limit(1);
        creatorId = firstThreadMessage?.userId;
      }

      // Creator can delete only if nobody else has joined the conversation.
      // Once another user posts, the thread is "shared" and only an
      // admin (MANAGE_CHANNELS above) can remove it.
      const isCreator = creatorId !== undefined && creatorId === ctx.userId;

      if (!isCreator) {
        await ctx.needsPermission(Permission.MANAGE_CHANNELS, thread.serverId);
      } else {
        const [foreignMessage] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, input.threadId),
              ne(messages.userId, ctx.userId)
            )
          )
          .limit(1);

        invariant(!foreignMessage, {
          code: 'FORBIDDEN',
          message:
            'Cannot delete thread once another user has posted. Ask an admin.'
        });
      }
    }

    // Delete the thread channel (cascades to messages, forumPostTags, threadFollowers)
    await db.delete(channels).where(eq(channels.id, input.threadId));

    publishChannel(input.threadId, 'delete', thread.serverId);

    const memberIds = await getServerMemberIds(thread.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_DELETE, input.threadId);
  });

export { deleteThreadRoute };
