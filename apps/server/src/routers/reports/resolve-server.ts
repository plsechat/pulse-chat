import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { reports, users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { takeDownReportedContent } from '../../utils/report-takedown';
import { banServerMember, kickFromServer } from '../../utils/server-moderation';

/**
 * Server-mod resolution of a queue entry. Kick removes the author from
 * this server; ban uses the same users.banned semantics as users.ban —
 * MANAGE_USERS mods already wield exactly that from the moderation
 * view. Escalate hands the report (snapshot included) to the instance
 * operator: it leaves this queue, status stays open. A report outside
 * the caller's server — or one already escalated — reads as nonexistent
 * so this can't be used as a cross-server oracle.
 */
const resolveServerRoute = serverProcedure(Permission.VIEW_REPORTS)
  .input(
    z.object({
      reportId: z.number().int().positive(),
      action: z.enum([
        'dismiss',
        'delete-content',
        'delete-and-kick',
        'delete-and-ban',
        'escalate'
      ])
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, input.reportId))
      .limit(1);

    invariant(
      report &&
        report.serverId === ctx.activeServerId &&
        report.audience === 'server',
      {
        code: 'NOT_FOUND',
        message: 'Report not found'
      }
    );
    invariant(report.status === 'open', {
      code: 'BAD_REQUEST',
      message: 'Report is already resolved.'
    });
    // Roles can change after the create-time target_mod trigger ran.
    invariant(report.targetUserId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot resolve a report about yourself.'
    });

    if (input.action === 'escalate') {
      await db
        .update(reports)
        .set({
          audience: 'instance',
          escalationReason: 'manual',
          escalatedAt: Date.now(),
          escalatedBy: ctx.userId
        })
        .where(eq(reports.id, report.id));

      enqueueActivityLog({
        type: ActivityLogType.REPORT_ESCALATED,
        userId: report.targetUserId,
        serverId: ctx.activeServerId,
        details: {
          reportId: report.id,
          reason: 'manual',
          escalatedBy: ctx.userId
        }
      });
      return;
    }

    if (input.action !== 'dismiss') {
      await takeDownReportedContent(report, ctx.pubsub);
    }

    if (input.action === 'delete-and-kick') {
      await kickFromServer({
        targetUserId: report.targetUserId,
        serverId: ctx.activeServerId,
        reason: `Report #${report.id}: ${report.reason}`,
        kickedBy: ctx.userId,
        getUserWs: ctx.getUserWs,
        pubsub: ctx.pubsub
      });
    } else if (input.action === 'delete-and-ban') {
      const [target] = await db
        .select({ banned: users.banned, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, report.targetUserId))
        .limit(1);

      if (target && !target.banned && !target.deletedAt) {
        await banServerMember({
          targetUserId: report.targetUserId,
          serverId: ctx.activeServerId,
          reason: `Report #${report.id}: ${report.reason}`,
          bannedBy: ctx.userId,
          getUserWs: ctx.getUserWs
        });
      }
    }

    await db
      .update(reports)
      .set({
        status: input.action === 'dismiss' ? 'dismissed' : 'resolved',
        resolvedBy: ctx.userId,
        resolvedAt: Date.now()
      })
      .where(eq(reports.id, report.id));

    enqueueActivityLog({
      type: ActivityLogType.REPORT_RESOLVED,
      userId: report.targetUserId,
      serverId: ctx.activeServerId,
      details: {
        reportId: report.id,
        action: input.action,
        resolvedBy: ctx.userId
      }
    });
  });

export { resolveServerRoute };
