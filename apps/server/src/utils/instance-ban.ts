import { ActivityLogType, DisconnectCode } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import { users } from '../db/schema';
import { enqueueActivityLog } from '../queues/activity-log';
import { markBanned } from './banned-cache';
import type { Context } from './trpc';

/**
 * Instance-wide ban core, shared by admin.banUser and report
 * resolution: disconnect every live socket, flip users.banned, reflect
 * the banned cache the auth middleware reads, and fan out the flag.
 * Caller is responsible for authorization and target validation.
 */
const applyInstanceBan = async (opts: {
  targetUserId: number;
  reason: string | null;
  bannedBy: number;
  getUserWs: Context['getUserWs'];
}): Promise<void> => {
  const userConnections = opts.getUserWs(opts.targetUserId);
  if (userConnections) {
    for (const ws of userConnections) {
      ws.close(DisconnectCode.BANNED, opts.reason ?? undefined);
    }
  }

  await db
    .update(users)
    .set({
      banned: true,
      banReason: opts.reason,
      bannedAt: Date.now()
    })
    .where(eq(users.id, opts.targetUserId));

  markBanned(opts.targetUserId);
  publishUser(opts.targetUserId, 'update');

  enqueueActivityLog({
    type: ActivityLogType.USER_BANNED,
    userId: opts.targetUserId,
    details: {
      reason: opts.reason ?? undefined,
      bannedBy: opts.bannedBy
    }
  });
};

export { applyInstanceBan };
