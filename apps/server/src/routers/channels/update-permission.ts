import {
  ActivityLogType,
  ChannelPermission,
  Permission
} from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { rotateFileAccessTokens } from '../../db/mutations/channels';
import { publishChannelPermissions, publishChannelVisibility } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import {
  channelRolePermissions,
  channels,
  channelUserPermissions
} from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';

const allPermissions = Object.values(ChannelPermission);

const updatePermissionsRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z
      .object({
        channelId: z.number().int().positive(),
        userId: z.number().int().positive().optional(),
        roleId: z.number().int().positive().optional(),
        isCreate: z.boolean().optional().default(false),
        permissions: z.array(z.enum(ChannelPermission)).default([])
      })
      .refine((data) => !!(data.userId || data.roleId), {
        message: 'Either userId or roleId must be provided'
      })
      .refine((data) => !(data.userId && data.roleId), {
        message: 'Cannot specify both userId and roleId'
      })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify the channel belongs to the caller's active server
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found in this server'
    });

    const permissions = input.isCreate ? [] : input.permissions;

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

        const values = allPermissions.map((perm) => ({
          channelId: input.channelId,
          userId: input.userId!,
          permission: perm,
          allow: permissions.includes(perm),
          createdAt: Date.now()
        }));

        await tx.insert(channelUserPermissions).values(values);
      } else if (input.roleId) {
        await tx
          .delete(channelRolePermissions)
          .where(
            and(
              eq(channelRolePermissions.channelId, input.channelId),
              eq(channelRolePermissions.roleId, input.roleId)
            )
          );

        const values = allPermissions.map((perm) => ({
          channelId: input.channelId,
          roleId: input.roleId!,
          permission: perm,
          allow: permissions.includes(perm),
          createdAt: Date.now()
        }));

        await tx.insert(channelRolePermissions).values(values);
      }
    });

    ctx.invalidatePermissionCache();
    invalidateAllPermissionCaches();
    // An override can take VIEW_CHANNEL away: re-key the channel's
    // attachment URLs so whoever just lost it cannot keep using them.
    await rotateFileAccessTokens({
      serverId: ctx.activeServerId,
      channelId: input.channelId
    });
    publishChannelPermissions(
      await getAffectedUserIdsForChannel(input.channelId)
    );
    // Overrides decide who may VIEW a private channel: members who just
    // gained or lost it need the channel added to / removed from their
    // sidebar, not only a new permission map.
    await publishChannelVisibility(input.channelId);
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_CHANNEL_PERMISSIONS,
      userId: ctx.user.id,
      details: {
        channelId: input.channelId,
        targetUserId: input.userId,
        targetRoleId: input.roleId,
        permissions: allPermissions.map((perm) => ({
          permission: perm,
          allow: permissions.includes(perm)
        }))
      }
    });
  });

export { updatePermissionsRoute };
