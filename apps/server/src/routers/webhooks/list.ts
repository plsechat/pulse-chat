import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, webhooks } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const listWebhooksRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().optional()
    })
  )
  .query(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_WEBHOOKS);

    if (input.channelId) {
      // Verify the channel belongs to the caller's active server
      const [channel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.id, input.channelId),
            eq(channels.serverId, ctx.activeServerId!)
          )
        )
        .limit(1);

      invariant(channel, {
        code: 'NOT_FOUND',
        message: 'Channel not found'
      });

      return db
        .select()
        .from(webhooks)
        .where(eq(webhooks.channelId, input.channelId));
    }

    return db
      .select()
      .from(webhooks)
      .where(eq(webhooks.serverId, ctx.activeServerId!));
  });

export { listWebhooksRoute };
