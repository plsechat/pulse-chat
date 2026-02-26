import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, threadFollowers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const followThreadRoute = protectedProcedure
  .input(
    z.object({
      threadId: z.number(),
      follow: z.boolean()
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

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
  .input(z.object({ threadId: z.number() }))
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
