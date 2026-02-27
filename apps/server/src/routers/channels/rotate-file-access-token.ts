import { ActivityLogType, Permission } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const rotateFileAccessTokenRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
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

    const newToken = randomUUIDv7();

    await db
      .update(channels)
      .set({
        fileAccessToken: newToken,
        fileAccessTokenUpdatedAt: Date.now()
      })
      .where(eq(channels.id, input.channelId));

    enqueueActivityLog({
      type: ActivityLogType.ROTATE_CHANNEL_FILE_ACCESS_TOKEN,
      userId: ctx.user.id
    });
  });

export { rotateFileAccessTokenRoute };
