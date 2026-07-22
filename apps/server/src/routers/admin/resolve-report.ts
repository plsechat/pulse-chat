import { ActivityLogType } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { reports, users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { applyInstanceBan } from '../../utils/instance-ban';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { takeDownReportedContent } from '../../utils/report-takedown';

/**
 * Operator resolution. Acts on any OPEN report regardless of audience —
 * the operator may step into a server-audience receipt directly (their
 * infrastructure, their override). Takedown mirrors the regular
 * deletion routes exactly, so clients can't tell an admin takedown from
 * an author delete. Ban here is the INSTANCE ban (shared core with
 * admin.banUser). If the reported message is already gone (author
 * deleted it; the FK went NULL), takedown degrades to a plain resolve.
 */
const resolveReportRoute = instanceOwnerProcedure
  .input(
    z.object({
      reportId: z.number().int().positive(),
      action: z.enum(['dismiss', 'delete-content', 'delete-and-ban'])
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, input.reportId))
      .limit(1);

    invariant(report, {
      code: 'NOT_FOUND',
      message: 'Report not found'
    });
    invariant(report.status === 'open', {
      code: 'BAD_REQUEST',
      message: 'Report is already resolved.'
    });

    if (input.action !== 'dismiss') {
      await takeDownReportedContent(report, ctx.pubsub);
    }

    if (input.action === 'delete-and-ban') {
      const [target] = await db
        .select({ banned: users.banned, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, report.targetUserId))
        .limit(1);

      if (target && !target.banned && !target.deletedAt) {
        await applyInstanceBan({
          targetUserId: report.targetUserId,
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
      details: {
        reportId: report.id,
        action: input.action,
        resolvedBy: ctx.userId
      }
    });
  });

export { resolveReportRoute };
