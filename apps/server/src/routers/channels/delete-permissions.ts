import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannelPermissions } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import {
  channelRolePermissions,
  channels,
  channelUserPermissions
} from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deletePermissionsRoute = protectedProcedure
  .input(
    z
      .object({
        channelId: z.number(),
        userId: z.number().optional(),
        roleId: z.number().optional()
      })
      .refine((data) => !!(data.userId || data.roleId), {
        message: 'Either userId or roleId must be provided'
      })
      .refine((data) => !(data.userId && data.roleId), {
        message: 'Cannot specify both userId and roleId'
      })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    // Verify the channel belongs to the caller's active server
    const [ch] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(ch, {
      code: 'NOT_FOUND',
      message: `Channel ${input.channelId} not found in this server`
    });

    const affectedUserIds = await getAffectedUserIdsForChannel(input.channelId);

    await db.transaction(async (tx) => {
      if (input.userId) {
        await tx
          .delete(channelUserPermissions)
          .where(
            and(
              eq(channelUserPermissions.channelId, input.channelId),
              eq(channelUserPermissions.userId, input.userId)
            )
          );
      } else if (input.roleId) {
        await tx
          .delete(channelRolePermissions)
          .where(
            and(
              eq(channelRolePermissions.channelId, input.channelId),
              eq(channelRolePermissions.roleId, input.roleId)
            )
          );
      }
    });

    publishChannelPermissions(affectedUserIds);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_CHANNEL_PERMISSIONS,
      userId: ctx.user.id,
      details: {
        channelId: input.channelId,
        targetUserId: input.userId,
        targetRoleId: input.roleId
      }
    });
  });

export { deletePermissionsRoute };
