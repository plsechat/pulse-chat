import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { isServerMember } from '../../db/queries/servers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { markUnbanned } from '../../utils/banned-cache';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const unbanRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    // Mirror ban.ts: only allow unbanning users who are members of the
    // caller's active server. Without this, MANAGE_USERS in server A could
    // unban a user banned by server B's admin.
    const isMember = await isServerMember(ctx.activeServerId!, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    await db
      .update(users)
      .set({
        banned: false,
        banReason: null
      })
      .where(eq(users.id, input.userId));

    // Drop them from the auth middleware's in-memory banned set so
    // their next protected procedure call goes through.
    markUnbanned(input.userId);

    publishUser(input.userId, 'update');

    enqueueActivityLog({
      type: ActivityLogType.USER_UNBANNED,
      userId: input.userId,
      details: {
        unbannedBy: ctx.userId
      }
    });
  });

export { unbanRoute };
