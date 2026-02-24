import { Permission } from '@pulse/shared';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, webhooks } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const createWebhookRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(80),
      channelId: z.number(),
      avatarFileId: z.number().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_WEBHOOKS);

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

    const [webhook] = await db
      .insert(webhooks)
      .values({
        name: input.name,
        channelId: input.channelId,
        token: randomUUID(),
        avatarFileId: input.avatarFileId ?? null,
        createdBy: ctx.userId,
        serverId: ctx.activeServerId!,
        createdAt: Date.now()
      })
      .returning();

    return webhook;
  });

export { createWebhookRoute };
