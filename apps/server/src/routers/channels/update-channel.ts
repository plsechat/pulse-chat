import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { channels, servers } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { getUserRoles } from '../users/get-user-roles';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updateChannelRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().min(1),
      name: z.string().min(2).max(24).optional(),
      topic: z.string().max(128).nullable().optional(),
      private: z.boolean().optional(),
      slowMode: z.number().min(0).max(21600).optional(),
      e2ee: z.boolean().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    // E2EE can only be enabled (not disabled), and only by server owner
    if (input.e2ee !== undefined) {
      invariant(input.e2ee === true, {
        code: 'BAD_REQUEST',
        message: 'E2EE cannot be disabled once enabled'
      });

      // Look up the channel and verify it belongs to the caller's active server
      const [channel] = await db
        .select({ serverId: channels.serverId })
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

      const [server] = await db
        .select({ ownerId: servers.ownerId })
        .from(servers)
        .where(eq(servers.id, channel.serverId))
        .limit(1);

      // Check ownerId on server record, or fall back to Owner role
      // (the default seeded server has ownerId = null)
      const isOwnerById = server && server.ownerId === ctx.userId;
      const userRoles = await getUserRoles(ctx.userId, channel.serverId);
      const isOwnerByRole = userRoles.some((r) => r.id === OWNER_ROLE_ID);

      invariant(isOwnerById || isOwnerByRole, {
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
        e2ee: input.e2ee
      })
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId!)
        )
      )
      .returning();

    publishChannel(updatedChannel!.id, 'update');
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_CHANNEL,
      userId: ctx.user.id,
      details: {
        channelId: updatedChannel!.id,
        values: input
      }
    });
  });

export { updateChannelRoute };
