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
import { serverProcedureFor } from '../../utils/procedures';
import { notifyBridgeChannelCreated } from '../servers/bridge-hooks';

const addChannelRoute = serverProcedureFor(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      type: z.enum(ChannelType),
      name: z.string().min(1).max(24),
      categoryId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
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
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning();

      return newChannel!;
    });

    // A mediasoup router only for channels that can carry voice — boot
    // (runtimes/index.ts) and voice.join create them the same way.
    if (channel.type === ChannelType.VOICE) {
      const runtime = new VoiceRuntime(channel.id);

      await runtime.init();
    }

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

    // A server bridged as a whole picks the new channel up: the pairing
    // itself runs detached (webhook creation is paced); only the
    // "is this server linked" lookup is awaited here.
    await notifyBridgeChannelCreated(channel.serverId);

    return channel.id;
  });

export { addChannelRoute };
