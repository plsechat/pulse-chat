import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { evictRuntime } from '../../utils/voice-cleanup';

const deleteChannelRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      channelId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const scope = and(
      eq(channels.id, input.channelId),
      eq(channels.serverId, ctx.activeServerId)
    );

    const [channel] = await db.select().from(channels).where(scope).limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    // A live call in the channel ends for its occupants (USER_LEAVE_VOICE
    // to the server) BEFORE the row goes — the leave fan-out resolves its
    // audience through the channel's server.
    const runtime = VoiceRuntime.findById(channel.id);

    if (runtime) {
      await evictRuntime(runtime);
    }

    const [removedChannel] = await db.delete(channels).where(scope).returning();

    invariant(removedChannel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

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
