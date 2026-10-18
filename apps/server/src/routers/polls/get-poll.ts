import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { buildPollView, getPollByMessageInServers } from '../../db/queries/polls';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * The card's loader, addressed by the message it renders. A previewer
 * reads poll messages like any other, so the previewed server is in
 * scope next to the active one; the channel permission decides.
 */
const getPollRoute = protectedProcedure
  .input(z.object({ messageId: z.number().int().positive() }))
  .query(async ({ input, ctx }) => {
    const scope = [ctx.activeServerId, ctx.previewServerId].filter(
      (id): id is number => id !== undefined
    );
    const row = await getPollByMessageInServers(input.messageId, scope);

    invariant(row, { code: 'NOT_FOUND', message: 'Poll not found' });

    await ctx.needsChannelPermission(row.channel.id, ChannelPermission.VIEW_CHANNEL);

    return buildPollView(row.poll, ctx.userId);
  });

export { getPollRoute };
