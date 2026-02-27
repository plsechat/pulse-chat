import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getChannelRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().min(1)
    })
  )
  .query(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: `Channel ${input.channelId} not found`
    });

    return channel;
  });

export { getChannelRoute };
