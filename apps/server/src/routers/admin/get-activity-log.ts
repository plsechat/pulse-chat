import { ActivityLogType } from '@pulse/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { activityLog, servers, users } from '../../db/schema';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance-wide activity log viewer. Rows are the moderation/audit
 * events the server already records (enqueueActivityLog) — metadata
 * about actions, never message content.
 */
const getActivityLogRoute = instanceOwnerProcedure
  .input(
    z.object({
      type: z.nativeEnum(ActivityLogType).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50)
    })
  )
  .query(async ({ input }) => {
    const scope =
      input.type !== undefined ? eq(activityLog.type, input.type) : undefined;

    const rows = await db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        details: activityLog.details,
        ip: activityLog.ip,
        createdAt: activityLog.createdAt,
        userId: activityLog.userId,
        userName: users.name,
        serverName: servers.name
      })
      .from(activityLog)
      .innerJoin(users, eq(activityLog.userId, users.id))
      .leftJoin(servers, eq(activityLog.serverId, servers.id))
      .where(scope !== undefined ? and(scope) : undefined)
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(input.limit)
      .offset(input.offset);

    const [total] = await db
      .select({ value: count() })
      .from(activityLog)
      .where(scope !== undefined ? and(scope) : undefined);

    return { entries: rows, total: total?.value ?? 0 };
  });

export { getActivityLogRoute };
