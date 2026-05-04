import { ServerEvents } from '@pulse/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmE2eeSenderKeys } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure, userSubscription } from '../../utils/trpc';

// Mirror of e2ee.distributeSenderKeysBatch but scoped to a DM channel.
// Permission check is "is the caller a member of the DM" instead of
// channel VIEW_CHANNEL — DMs don't have role-based permissions.
const distributeSenderKeysRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      // Phase B chain rotation id. Defaults to 1 for the first chain
      // and pre-Phase-B clients still in the wild.
      senderKeyId: z.number().int().min(1).default(1),
      distributions: z.array(
        z.object({
          toUserId: z.number(),
          distributionMessage: z.string()
        })
      )
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.distributions.length === 0) return;

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);
    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    // Each recipient must be a current member — silently dropping
    // non-members would mask bugs and risk leaking the key to a
    // formerly-in-the-channel user via a stale write.
    const memberSet = new Set(memberIds);
    for (const d of input.distributions) {
      invariant(memberSet.has(d.toUserId), {
        code: 'BAD_REQUEST',
        message: 'Recipient is not a member of this DM channel'
      });
    }

    await db.insert(dmE2eeSenderKeys).values(
      input.distributions.map((d) => ({
        dmChannelId: input.dmChannelId,
        senderKeyId: input.senderKeyId,
        fromUserId: ctx.userId,
        toUserId: d.toUserId,
        distributionMessage: d.distributionMessage,
        createdAt: Date.now()
      }))
    );

    for (const d of input.distributions) {
      pubsub.publishFor(d.toUserId, ServerEvents.DM_SENDER_KEY_DISTRIBUTION, {
        dmChannelId: input.dmChannelId,
        fromUserId: ctx.userId
      });
    }
  });

const getPendingSenderKeysRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number().optional() }))
  .query(async ({ ctx, input }) => {
    const conditions = [eq(dmE2eeSenderKeys.toUserId, ctx.userId)];
    if (input.dmChannelId !== undefined) {
      conditions.push(eq(dmE2eeSenderKeys.dmChannelId, input.dmChannelId));
    }

    const rows = await db
      .select()
      .from(dmE2eeSenderKeys)
      .where(and(...conditions));

    return rows.map((r) => ({
      id: r.id,
      dmChannelId: r.dmChannelId,
      senderKeyId: r.senderKeyId,
      fromUserId: r.fromUserId,
      distributionMessage: r.distributionMessage
    }));
  });

const acknowledgeSenderKeysRoute = protectedProcedure
  .input(z.object({ ids: z.array(z.number()) }))
  .mutation(async ({ ctx, input }) => {
    if (input.ids.length === 0) return;

    await db
      .delete(dmE2eeSenderKeys)
      .where(
        and(
          eq(dmE2eeSenderKeys.toUserId, ctx.userId),
          sql`${dmE2eeSenderKeys.id} IN (${sql.join(
            input.ids.map((id) => sql`${id}`),
            sql`, `
          )})`
        )
      );
  });

const onSenderKeyDistributionRoute = userSubscription(
  ServerEvents.DM_SENDER_KEY_DISTRIBUTION
);

export {
  acknowledgeSenderKeysRoute as acknowledgeDmSenderKeysRoute,
  distributeSenderKeysRoute as distributeDmSenderKeysRoute,
  getPendingSenderKeysRoute as getPendingDmSenderKeysRoute,
  onSenderKeyDistributionRoute as onDmSenderKeyDistributionRoute
};
