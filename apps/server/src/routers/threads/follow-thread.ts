import { ChannelPermission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, threadFollowers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { protectedProcedure } from '../../utils/trpc';

const followThreadRoute = serverProcedure()
  .input(
    z.object({
      threadId: z.number().int().positive(),
      follow: z.boolean()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify the thread exists and belongs to the caller's active server
    const [thread] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.threadId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(thread, {
      code: 'NOT_FOUND',
      message: 'Thread not found'
    });

    // Following subscribes to a thread's traffic — only viewers may.
    await ctx.needsChannelPermission(
      thread.id,
      ChannelPermission.VIEW_CHANNEL
    );

    if (input.follow) {
      await db
        .insert(threadFollowers)
        .values({
          threadId: input.threadId,
          userId: ctx.userId,
          createdAt: Date.now()
        })
        .onConflictDoNothing();
    } else {
      await db
        .delete(threadFollowers)
        .where(
          and(
            eq(threadFollowers.threadId, input.threadId),
            eq(threadFollowers.userId, ctx.userId)
          )
        );
    }

    return { following: input.follow };
  });

const getFollowStatusRoute = protectedProcedure
  .input(z.object({ threadId: z.number().int().positive() }))
  .query(async ({ input, ctx }) => {
    const [row] = await db
      .select({ threadId: threadFollowers.threadId })
      .from(threadFollowers)
      .where(
        and(
          eq(threadFollowers.threadId, input.threadId),
          eq(threadFollowers.userId, ctx.userId)
        )
      )
      .limit(1);

    return { following: !!row };
  });

export { followThreadRoute, getFollowStatusRoute };
