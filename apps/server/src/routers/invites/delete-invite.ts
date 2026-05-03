import { ActivityLogType, Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { invites } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteInviteRoute = protectedProcedure
  .input(
    z.object({
      inviteId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_INVITES);

    // Scope the delete to the caller's active server. Without this,
    // MANAGE_INVITES in server A could delete invites belonging to server B.
    const [removedInvite] = await db
      .delete(invites)
      .where(
        and(
          eq(invites.id, input.inviteId),
          eq(invites.serverId, ctx.activeServerId!)
        )
      )
      .returning();

    invariant(removedInvite, {
      code: 'NOT_FOUND',
      message: 'Invite not found'
    });

    // Notify server members so admin invite lists update
    const memberIds = await getServerMemberIds(removedInvite.serverId);
    ctx.pubsub.publishFor(memberIds, ServerEvents.INVITE_DELETE, {
      inviteId: removedInvite.id,
      serverId: removedInvite.serverId
    });

    enqueueActivityLog({
      type: ActivityLogType.DELETED_INVITE,
      userId: ctx.user.id,
      details: {
        code: removedInvite.code
      }
    });
  });

export { deleteInviteRoute };
