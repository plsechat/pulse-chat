import { ChannelPermission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  buildPollView,
  getPollInServer,
  publishPollUpdate
} from '../../db/queries/polls';
import { pollVotes } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const MAX_OPTION_KEY_LENGTH = 8;

const voteInput = z.object({
  pollId: z.number().int().positive(),
  optionKey: z.string().min(1).max(MAX_OPTION_KEY_LENGTH)
});

/**
 * Voting needs only VIEW on the channel — the poll is read-only
 * otherwise, like a reaction. A closed poll refuses both directions.
 * The route returns the caller's view (own choices included); everyone
 * else learns the new counts through POLL_UPDATE.
 */
const loadOpenPoll = async (
  ctx: {
    activeServerId: number;
    needsChannelPermission: (
      channelId: number,
      permission: ChannelPermission
    ) => Promise<void>;
  },
  pollId: number,
  optionKey: string
) => {
  const row = await getPollInServer(pollId, ctx.activeServerId);

  invariant(row, { code: 'NOT_FOUND', message: 'Poll not found' });

  await ctx.needsChannelPermission(row.channel.id, ChannelPermission.VIEW_CHANNEL);

  invariant(row.poll.closedAt === null, {
    code: 'BAD_REQUEST',
    message: 'This poll is closed'
  });

  invariant(row.poll.options.some((o) => o.key === optionKey), {
    code: 'BAD_REQUEST',
    message: 'Unknown poll option'
  });

  return row.poll;
};

const voteRoute = serverProcedure()
  .input(voteInput)
  .mutation(async ({ input, ctx }) => {
    const poll = await loadOpenPoll(ctx, input.pollId, input.optionKey);

    // Single choice: the new vote replaces the old one in the same
    // statement pair, so a double click never leaves two rows.
    if (!poll.multiple) {
      await db
        .delete(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, ctx.userId)));
    }

    await db
      .insert(pollVotes)
      .values({
        pollId: poll.id,
        userId: ctx.userId,
        optionKey: input.optionKey,
        createdAt: Date.now()
      })
      .onConflictDoNothing();

    publishPollUpdate(poll);

    return buildPollView(poll, ctx.userId);
  });

const unvoteRoute = serverProcedure()
  .input(voteInput)
  .mutation(async ({ input, ctx }) => {
    const poll = await loadOpenPoll(ctx, input.pollId, input.optionKey);

    await db
      .delete(pollVotes)
      .where(
        and(
          eq(pollVotes.pollId, poll.id),
          eq(pollVotes.userId, ctx.userId),
          eq(pollVotes.optionKey, input.optionKey)
        )
      );

    publishPollUpdate(poll);

    return buildPollView(poll, ctx.userId);
  });

export { unvoteRoute, voteRoute };
