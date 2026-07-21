import { ActivityLogType, DisconnectCode } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { markBanned } from '../../utils/banned-cache';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance-wide ban from the admin panel. Bans have always been
 * instance-wide (users.banned + the banned cache the auth middleware
 * reads); this route just removes the members-of-my-active-server
 * requirement the moderator route (users.ban) carries, so the operator
 * can ban ANY account. No federated relay: an instance-level ban of a
 * shadow user simply cuts their access here — their home instance
 * keeps its own records.
 */
const banUserRoute = instanceOwnerProcedure
  .input(
    z.object({
      userId: z.number().int().positive(),
      reason: z.string().max(256).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot ban yourself.'
    });

    const [target] = await db
      .select({ id: users.id, banned: users.banned, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    invariant(target && !target.deletedAt, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    invariant(!target.banned, {
      code: 'BAD_REQUEST',
      message: 'User is already banned.'
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

    markBanned(input.userId);
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

export { banUserRoute };
