import { ActivityLogType } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { markUnbanned } from '../../utils/banned-cache';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance-wide unban. Unlike the moderator route (users.unban), which
 * can only reach members of the caller's active server, the operator
 * can unban ANY account — including one banned out of every membership.
 */
const unbanUserRoute = instanceOwnerProcedure
  .input(
    z.object({
      userId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [target] = await db
      .select({ id: users.id, banned: users.banned })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    invariant(target, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    invariant(target.banned, {
      code: 'BAD_REQUEST',
      message: 'User is not banned.'
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

export { unbanUserRoute };
