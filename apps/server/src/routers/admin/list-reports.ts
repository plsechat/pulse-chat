import { and, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db';
import { reports, servers, users } from '../../db/schema';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * The operator's view. audience 'instance' = the actionable queue (DM
 * and account reports, plus everything escalated out of a server
 * queue); audience 'server' = receipts — reports the server's own mods
 * own, visible here with snapshot and outcome for oversight. Each row
 * carries ONLY the reported item (the reporter-granted snapshot) plus
 * its context — never a browse handle into the surrounding
 * conversation.
 */
const listReportsRoute = instanceOwnerProcedure
  .input(
    z.object({
      audience: z.enum(['instance', 'server']).default('instance'),
      status: z.enum(['open', 'resolved', 'dismissed']).default('open'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50)
    })
  )
  .query(async ({ input }) => {
    const reporter = alias(users, 'reporter');
    const target = alias(users, 'target');
    const resolver = alias(users, 'resolver');

    const rows = await db
      .select({
        id: reports.id,
        kind: reports.kind,
        reason: reports.reason,
        details: reports.details,
        contentSnapshot: reports.contentSnapshot,
        snapshotAttested: reports.snapshotAttested,
        audience: reports.audience,
        escalationReason: reports.escalationReason,
        status: reports.status,
        createdAt: reports.createdAt,
        resolvedAt: reports.resolvedAt,
        targetMessageId: reports.targetMessageId,
        targetDmMessageId: reports.targetDmMessageId,
        targetUserId: reports.targetUserId,
        targetName: target.name,
        targetBanned: target.banned,
        targetDeletedAt: target.deletedAt,
        reporterId: reports.reporterId,
        reporterName: reporter.name,
        resolverName: resolver.name,
        serverName: servers.name
      })
      .from(reports)
      .innerJoin(target, eq(reports.targetUserId, target.id))
      .innerJoin(reporter, eq(reports.reporterId, reporter.id))
      .leftJoin(resolver, eq(reports.resolvedBy, resolver.id))
      .leftJoin(servers, eq(reports.serverId, servers.id))
      .where(
        and(
          eq(reports.audience, input.audience),
          eq(reports.status, input.status)
        )
      )
      .orderBy(desc(reports.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const [total] = await db
      .select({ value: count() })
      .from(reports)
      .where(
        and(
          eq(reports.audience, input.audience),
          eq(reports.status, input.status)
        )
      );

    return { reports: rows, total: total?.value ?? 0 };
  });

export { listReportsRoute };
