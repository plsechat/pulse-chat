import { Permission } from '@pulse/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db';
import { reports, users } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

/**
 * The server moderators' report queue: channel-message reports about
 * THIS server that no trigger escalated. Escalated reports (manual or
 * stale) move to the operator's queue and leave this one — resolved
 * and dismissed rows the mods handled themselves stay visible under
 * their status filters.
 */
const listServerQueueRoute = serverProcedure(Permission.VIEW_REPORTS)
  .input(
    z.object({
      status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50)
    })
  )
  .query(async ({ ctx, input }) => {
    const reporter = alias(users, 'reporter');
    const target = alias(users, 'target');
    const resolver = alias(users, 'resolver');

    const scope = and(
      eq(reports.serverId, ctx.activeServerId),
      eq(reports.audience, 'server'),
      eq(reports.status, input.status)
    );

    const rows = await db
      .select({
        id: reports.id,
        kind: reports.kind,
        reason: reports.reason,
        details: reports.details,
        contentSnapshot: reports.contentSnapshot,
        snapshotAttested: reports.snapshotAttested,
        status: reports.status,
        createdAt: reports.createdAt,
        resolvedAt: reports.resolvedAt,
        targetMessageId: reports.targetMessageId,
        targetUserId: reports.targetUserId,
        targetName: target.name,
        targetBanned: target.banned,
        targetDeletedAt: target.deletedAt,
        reporterId: reports.reporterId,
        reporterName: reporter.name,
        resolverName: resolver.name
      })
      .from(reports)
      .innerJoin(target, eq(reports.targetUserId, target.id))
      .innerJoin(reporter, eq(reports.reporterId, reporter.id))
      .leftJoin(resolver, eq(reports.resolvedBy, resolver.id))
      .where(scope)
      .orderBy(desc(reports.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const [total] = await db.select({ value: count() }).from(reports).where(scope);

    return { reports: rows, total: total?.value ?? 0 };
  });

export { listServerQueueRoute };
