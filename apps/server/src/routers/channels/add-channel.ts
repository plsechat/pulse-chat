import { ActivityLogType, ChannelType, Permission } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { categories, channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const addChannelRoute = protectedProcedure
  .input(
    z.object({
      type: z.enum(ChannelType),
      name: z.string().min(1).max(16),
      categoryId: z.number(),
      serverId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS, input.serverId);

    // Verify the category belongs to the specified server
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, input.categoryId),
          eq(categories.serverId, input.serverId)
        )
      )
      .limit(1);

    invariant(category, {
      code: 'NOT_FOUND',
      message: 'Category not found'
    });

    const channel = await db.transaction(async (tx) => {
      const [maxPositionChannel] = await tx
        .select()
        .from(channels)
        .orderBy(desc(channels.position))
        .where(eq(channels.categoryId, input.categoryId))
        .limit(1);

      const now = Date.now();

      const [newChannel] = await tx
        .insert(channels)
        .values({
          position:
            maxPositionChannel?.position !== undefined
              ? maxPositionChannel.position + 1
              : 0,
          name: input.name,
          type: input.type,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          categoryId: input.categoryId,
          serverId: input.serverId,
          createdAt: now
        })
        .returning();

      return newChannel!;
    });

    const runtime = new VoiceRuntime(channel.id);

    await runtime.init();

    publishChannel(channel.id, 'create');
    enqueueActivityLog({
      type: ActivityLogType.CREATED_CHANNEL,
      userId: ctx.user.id,
      details: {
        channelId: channel.id,
        channelName: channel.name,
        type: channel.type as ChannelType
      }
    });

    return channel.id;
  });

export { addChannelRoute };
