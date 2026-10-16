import { ActivityLogType, ChannelType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { rotateFileAccessTokens } from '../../db/mutations/channels';
import { publishChannel } from '../../db/publishers';
import { isServerOwner } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';

const updateChannelRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      channelId: z.number().int().positive(),
      name: z.string().min(1).max(24).optional(),
      topic: z.string().max(128).nullable().optional(),
      private: z.boolean().optional(),
      slowMode: z.number().int().min(0).max(21600).optional(),
      e2ee: z.boolean().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // Load first, scoped to the active server: a channel of another
    // server (or none at all) is NOT_FOUND, never a crash on the update
    // result.
    const [channel] = await db
      .select({
        id: channels.id,
        type: channels.type,
        e2ee: channels.e2ee,
        private: channels.private
      })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    // E2EE can only be enabled (not disabled), only on text channels, and
    // only by the server owner.
    if (input.e2ee !== undefined) {
      invariant(input.e2ee === true, {
        code: 'BAD_REQUEST',
        message: 'E2EE cannot be disabled once enabled'
      });

      invariant(channel.type === ChannelType.TEXT, {
        code: 'BAD_REQUEST',
        message: 'E2EE can only be enabled on text channels'
      });

      invariant(await isServerOwner(ctx.activeServerId, ctx.userId), {
        code: 'FORBIDDEN',
        message: 'Only the server owner can enable E2EE on channels'
      });
    }

    const [updatedChannel] = await db
      .update(channels)
      .set({
        name: input.name,
        topic: input.topic,
        private: input.private,
        slowMode: input.slowMode,
        e2ee: input.e2ee,
        updatedAt: Date.now()
      })
      .where(eq(channels.id, channel.id))
      .returning({ id: channels.id });

    invariant(updatedChannel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    if (input.private !== undefined) invalidateAllPermissionCaches();

    // Who may see the channel just changed: every attachment URL minted
    // under the old visibility is re-keyed (see rotateFileAccessTokens).
    if (input.private !== undefined && input.private !== channel.private) {
      await rotateFileAccessTokens({
        serverId: ctx.activeServerId,
        channelId: channel.id
      });
    }

    publishChannel(updatedChannel.id, 'update');
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_CHANNEL,
      userId: ctx.user.id,
      details: {
        channelId: updatedChannel.id,
        values: input
      }
    });
  });

export { updateChannelRoute };
