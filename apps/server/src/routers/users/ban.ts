import { ActivityLogType, DisconnectCode, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { isServerMember } from '../../db/queries/servers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const banRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      reason: z.string().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(input.userId !== ctx.user.id, {
      code: 'BAD_REQUEST',
      message: 'You cannot ban yourself.'
    });

    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId!, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: `User ${input.userId} is not a member of this server`
    });

    const userConnections = ctx.getUserWs(input.userId);

    if (userConnections) {
      for (const ws of userConnections) {
        ws.close(DisconnectCode.BANNED, input.reason);
      }
    }

    await db
      .update(users)
      .set({
        banned: true,
        banReason: input.reason ?? null,
        bannedAt: Date.now()
      })
      .where(eq(users.id, input.userId));

    publishUser(input.userId, 'update');

    enqueueActivityLog({
      type: ActivityLogType.USER_BANNED,
      userId: input.userId,
      details: {
        reason: input.reason,
        bannedBy: ctx.userId
      }
    });
  });

export { banRoute };
