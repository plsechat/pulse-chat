import { and, desc, eq } from 'drizzle-orm';
import { db } from '..';
import { activityLog } from '../schema';

/**
 * Audit trail for one user, STRICTLY scoped to one server (mod view).
 * Unstamped legacy/global rows are excluded by design — moderating a
 * server must never surface activity from outside it (cross-server
 * scope rule).
 */
const getAuditLogForUser = async (
  userId: number,
  serverId: number,
  limit = 50
) =>
  db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.userId, userId),
        eq(activityLog.serverId, serverId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

export { getAuditLogForUser };
