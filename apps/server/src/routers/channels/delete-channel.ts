import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteChannelRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    const [removedChannel] = await db
      .delete(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId!)
        )
      )
      .returning();

    invariant(removedChannel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    const runtime = VoiceRuntime.findById(removedChannel.id);

    if (runtime) {
      runtime.destroy();
    }

    publishChannel(removedChannel.id, 'delete', removedChannel.serverId);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_CHANNEL,
      userId: ctx.user.id,
      details: {
        channelId: removedChannel.id,
        channelName: removedChannel.name
      }
    });
  });

export { deleteChannelRoute };
