import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannels } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteChannelRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    if (!channel) {
      return ctx.throwValidationError('dmChannelId', 'DM channel not found');
    }

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    if (!memberIds.includes(ctx.userId)) {
      ctx.throwValidationError('dmChannelId', 'Not a member of this channel');
    }

    // Delete the channel — cascades to members, messages, files, reactions, read states
    await db
      .delete(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId));

    // Notify all members (including the deleter, so other devices sync)
    for (const userId of memberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_DELETE, {
        dmChannelId: input.dmChannelId
      });
    }
  });

export { deleteChannelRoute };
