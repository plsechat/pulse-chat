import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '..';
import { enqueueActivityLog } from '../../queues/activity-log';
import { reports, rolePermissions, roles, servers, userRoles } from '../schema';

/**
 * True when `userId` would see `serverId`'s report queue: the server
 * owner, or any role in that server granting VIEW_REPORTS. Used by the
 * create-time `target_mod` escalation trigger — a report about someone
 * who can read the queue must not land in that queue.
 */
const isReportReviewer = async (
  serverId: number,
  userId: number
): Promise<boolean> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server?.ownerId === userId) return true;

  const [granted] = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(roles.serverId, serverId),
        eq(rolePermissions.permission, Permission.VIEW_REPORTS)
      )
    )
    .limit(1);
  return !!granted;
};

const STALE_REPORT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Move server-queue reports the mods have ignored for a week into the
 * operator's queue. Bounded single UPDATE; returns the moved ids.
 */
const escalateStaleReports = async (
  olderThanMs: number = STALE_REPORT_MS
): Promise<number[]> => {
  const cutoff = Date.now() - olderThanMs;
  const moved = await db
    .update(reports)
    .set({
      audience: 'instance',
      escalationReason: 'stale',
      escalatedAt: Date.now()
    })
    .where(
      and(
        eq(reports.audience, 'server'),
        eq(reports.status, 'open'),
        lt(reports.createdAt, cutoff)
      )
    )
    .returning({ id: reports.id, targetUserId: reports.targetUserId });

  for (const row of moved) {
    enqueueActivityLog({
      type: ActivityLogType.REPORT_ESCALATED,
      userId: row.targetUserId,
      details: { reportId: row.id, reason: 'stale', escalatedBy: null }
    });
  }

  return moved.map((r) => r.id);
};

export { escalateStaleReports, isReportReviewer, STALE_REPORT_MS };
