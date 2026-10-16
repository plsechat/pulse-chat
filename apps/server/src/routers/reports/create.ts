import { ActivityLogType } from '@pulse/shared';
import { and, count, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { isReportReviewer } from '../../db/queries/reports';
import { isServerMember } from '../../db/queries/servers';
import {
  channels,
  dmChannelMembers,
  dmMessages,
  federationInstances,
  messages,
  reports,
  serverMembers,
  servers,
  users
} from '../../db/schema';
import { logger } from '../../logger';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueRelay } from '../../utils/federation-outbox';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const REPORT_REASONS = ['illegal', 'spam', 'harassment', 'other'] as const;

/** Caps on what crosses to the peer — the local row keeps the full copy. */
const RELAY_MAX_DETAILS = 1000;
const RELAY_MAX_EXCERPT = 1000;

/**
 * A report against a federated (shadow) user also goes to that user's
 * home instance: the home is the only party that can act on the
 * account, and the local row only reaches this instance's moderators.
 * Queued through the federation outbox, so a home that is down still
 * gets it; the local report is created regardless.
 */
const relayReportToHome = async (args: {
  targetUserId: number;
  reporterId: number;
  serverId: number | null;
  kind: 'message' | 'dm_message' | 'user';
  reason: (typeof REPORT_REASONS)[number];
  details: string | null;
  contentSnapshot: string | null;
}): Promise<void> => {
  try {
    const [target] = await db
      .select({
        isFederated: users.isFederated,
        federatedInstanceId: users.federatedInstanceId,
        federatedPublicId: users.federatedPublicId
      })
      .from(users)
      .where(eq(users.id, args.targetUserId))
      .limit(1);
    if (
      !target?.isFederated ||
      !target.federatedInstanceId ||
      !target.federatedPublicId
    ) {
      return;
    }

    const [instance] = await db
      .select({ domain: federationInstances.domain })
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.id, target.federatedInstanceId),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);
    if (!instance) return;

    const [reporter] = await db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, args.reporterId))
      .limit(1);
    if (!reporter?.publicId) return;

    let serverPublicId: string | null = null;
    if (args.serverId !== null) {
      const [server] = await db
        .select({ publicId: servers.publicId })
        .from(servers)
        .where(eq(servers.id, args.serverId))
        .limit(1);
      serverPublicId = server?.publicId ?? null;
    }

    await enqueueRelay(instance.domain, '/federation/report-user', {
      subjectPublicId: target.federatedPublicId,
      reporterPublicId: reporter.publicId,
      serverPublicId,
      kind: args.kind,
      reason: args.reason,
      details: args.details?.slice(0, RELAY_MAX_DETAILS) ?? null,
      messageExcerpt: args.contentSnapshot?.slice(0, RELAY_MAX_EXCERPT) ?? null
    });
  } catch (err) {
    logger.error('[reports/create] federated report relay failed: %o', err);
  }
};

/** True when the two users share at least one server or DM channel. */
const sharesContextWith = async (
  userId: number,
  otherId: number
): Promise<boolean> => {
  const myServers = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));

  if (myServers.length > 0) {
    const [shared] = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.userId, otherId),
          inArray(
            serverMembers.serverId,
            myServers.map((s) => s.serverId)
          )
        )
      )
      .limit(1);
    if (shared) return true;
  }

  const myDms = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, userId));

  if (myDms.length === 0) return false;

  const [sharedDm] = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(
      and(
        eq(dmChannelMembers.userId, otherId),
        inArray(
          dmChannelMembers.dmChannelId,
          myDms.map((d) => d.dmChannelId)
        )
      )
    )
    .limit(1);
  return !!sharedDm;
};

/**
 * Participant-granted reporting. The reporter must be able to see the
 * target legitimately (server member / DM participant / shared
 * context). The snapshot rule: for PLAINTEXT targets the server
 * captures the stored content itself, so a reporter can't fabricate
 * what a message says; for E2EE targets the stored content is
 * ciphertext the server can't read, so the reporter's client attaches
 * its decrypted copy — reporter-attested, flagged as such.
 *
 * Routing: channel-message reports land in the server mods' queue
 * (audience 'server'); DM and account reports have no server-level
 * reviewer and go straight to the instance operator. Two create-time
 * triggers force a channel report up to the operator: reason 'illegal'
 * (the operator carries the infrastructure liability) and a target who
 * can read that server's queue (reporting a mod to the mods would only
 * tip them off).
 */
const createReportRoute = protectedProcedure
  .input(
    z.object({
      kind: z.enum(['message', 'dm_message', 'user']),
      targetId: z.number().int().positive(),
      reason: z.enum(REPORT_REASONS),
      details: z.string().max(1000).optional(),
      /** Reporter-side plaintext, used only when the target is E2EE. */
      decryptedContent: z.string().max(8000).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // Bound report volume per reporter (Bun is single-threaded; every
    // unbounded write path is a DoS lever).
    const windowStart = Date.now() - 10 * 60 * 1000;
    const [recent] = await db
      .select({ value: count() })
      .from(reports)
      .where(
        and(
          eq(reports.reporterId, ctx.userId),
          gt(reports.createdAt, windowStart)
        )
      );
    invariant((recent?.value ?? 0) < 10, {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many reports in a short time — try again later.'
    });

    let targetUserId: number;
    let targetMessageId: number | null = null;
    let targetDmMessageId: number | null = null;
    let serverId: number | null = null;
    let contentSnapshot: string | null = null;
    let snapshotAttested = false;

    if (input.kind === 'message') {
      const [row] = await db
        .select({
          id: messages.id,
          userId: messages.userId,
          content: messages.content,
          e2ee: messages.e2ee,
          serverId: channels.serverId
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .where(eq(messages.id, input.targetId))
        .limit(1);

      // Out-of-scope targets look identical to nonexistent ones.
      invariant(row && (await isServerMember(row.serverId, ctx.userId)), {
        code: 'NOT_FOUND',
        message: 'Message not found'
      });

      targetUserId = row.userId;
      targetMessageId = row.id;
      serverId = row.serverId;
      contentSnapshot = row.e2ee
        ? (input.decryptedContent ?? null)
        : row.content;
      snapshotAttested = row.e2ee && contentSnapshot !== null;
    } else if (input.kind === 'dm_message') {
      const [row] = await db
        .select({
          id: dmMessages.id,
          userId: dmMessages.userId,
          content: dmMessages.content,
          e2ee: dmMessages.e2ee,
          dmChannelId: dmMessages.dmChannelId
        })
        .from(dmMessages)
        .where(eq(dmMessages.id, input.targetId))
        .limit(1);

      const memberIds = row
        ? await getDmChannelMemberIds(row.dmChannelId)
        : [];
      invariant(row && memberIds.includes(ctx.userId), {
        code: 'NOT_FOUND',
        message: 'Message not found'
      });

      targetUserId = row.userId;
      targetDmMessageId = row.id;
      contentSnapshot = row.e2ee
        ? (input.decryptedContent ?? null)
        : row.content;
      snapshotAttested = row.e2ee && contentSnapshot !== null;
    } else {
      const [target] = await db
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, input.targetId))
        .limit(1);

      invariant(
        target &&
          !target.deletedAt &&
          (await sharesContextWith(ctx.userId, target.id)),
        {
          code: 'NOT_FOUND',
          message: 'User not found'
        }
      );

      targetUserId = target.id;
    }

    invariant(targetUserId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot report yourself.'
    });

    // One open report per reporter per target.
    const [existing] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.reporterId, ctx.userId),
          eq(reports.status, 'open'),
          eq(reports.kind, input.kind),
          input.kind === 'message'
            ? eq(reports.targetMessageId, input.targetId)
            : input.kind === 'dm_message'
              ? eq(reports.targetDmMessageId, input.targetId)
              : eq(reports.targetUserId, input.targetId)
        )
      )
      .limit(1);
    invariant(!existing, {
      code: 'BAD_REQUEST',
      message: 'You already have an open report for this.'
    });

    // Route the report. DM/account reports are natively operator-level
    // (audience 'instance', no escalationReason — nothing was moved);
    // a channel report only escalates on a trigger.
    let audience: 'server' | 'instance' = 'instance';
    let escalationReason: string | null = null;
    if (input.kind === 'message' && serverId !== null) {
      if (input.reason === 'illegal') {
        escalationReason = 'illegal';
      } else if (await isReportReviewer(serverId, targetUserId)) {
        escalationReason = 'target_mod';
      } else {
        audience = 'server';
      }
    }

    const [report] = await db
      .insert(reports)
      .values({
        kind: input.kind,
        targetUserId,
        targetMessageId,
        targetDmMessageId,
        serverId,
        reporterId: ctx.userId,
        reason: input.reason,
        details: input.details ?? null,
        contentSnapshot,
        snapshotAttested,
        audience,
        escalationReason,
        escalatedAt: escalationReason !== null ? Date.now() : null,
        createdAt: Date.now()
      })
      .returning({ id: reports.id });

    enqueueActivityLog({
      type: ActivityLogType.USER_REPORTED,
      userId: targetUserId,
      details: {
        reportId: report!.id,
        kind: input.kind,
        reason: input.reason,
        reportedBy: ctx.userId
      }
    });

    // Not awaited: the peer round-trip must not delay the reporter's
    // confirmation, and the helper never rejects.
    void relayReportToHome({
      targetUserId,
      reporterId: ctx.userId,
      serverId,
      kind: input.kind,
      reason: input.reason,
      details: input.details ?? null,
      contentSnapshot
    });
  });

export { createReportRoute };
