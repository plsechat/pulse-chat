import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '..';
import { activityLog } from '../schema';

/**
 * Audit trail for one user, scoped to a server (mod view). Includes
 * entries stamped with this serverId plus legacy/global rows (serverId
 * null — pre-stamping mod actions, account-level events). Rows stamped
 * for OTHER servers never leak (cross-server scope rule).
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
        or(eq(activityLog.serverId, serverId), isNull(activityLog.serverId))
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

export { getAuditLogForUser };
