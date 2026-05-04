import { ServerEvents } from '@pulse/shared';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmE2eeSenderKeys, users } from '../../db/schema';
import {
  announceFederatedGroupCreate,
  assignFederationGroupIdIfNeeded,
  getFederationGroupId,
  relayFederatedSkdm
} from '../../utils/federation-dm-group-dispatch';
import { invariant } from '../../utils/invariant';
import { logger } from '../../logger';
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

    // Phase D / D2 — split distributions into local vs federated.
    // Local recipients get the SKDM stored on this server (existing
    // behaviour). Federated recipients have their SKDM relayed to
    // their home instance via /federation/dm-sender-key, where it
    // lands in that instance's local dm_e2ee_sender_keys for the
    // recipient to fetch. Without this split, federated recipients
    // never see the SKDM (their client polls their home instance,
    // not ours), so group decryption breaks for them.
    const recipientUserIds = input.distributions.map((d) => d.toUserId);
    const recipientRows = await db
      .select({
        id: users.id,
        isFederated: users.isFederated
      })
      .from(users)
      .where(inArray(users.id, recipientUserIds));
    const isFederatedById = new Map(
      recipientRows.map((r) => [r.id, r.isFederated])
    );

    const localDists = input.distributions.filter(
      (d) => !isFederatedById.get(d.toUserId)
    );
    const federatedDists = input.distributions.filter(
      (d) => isFederatedById.get(d.toUserId) === true
    );

    if (localDists.length > 0) {
      await db.insert(dmE2eeSenderKeys).values(
        localDists.map((d) => ({
          dmChannelId: input.dmChannelId,
          senderKeyId: input.senderKeyId,
          fromUserId: ctx.userId,
          toUserId: d.toUserId,
          distributionMessage: d.distributionMessage,
          createdAt: Date.now()
        }))
      );

      for (const d of localDists) {
        pubsub.publishFor(d.toUserId, ServerEvents.DM_SENDER_KEY_DISTRIBUTION, {
          dmChannelId: input.dmChannelId,
          fromUserId: ctx.userId
        });
      }
    }

    if (federatedDists.length > 0) {
      // Self-heal for groups that pre-date Phase D / D2: assign a
      // federationGroupId on the fly and re-announce so peers build
      // their mirrors. New groups created via createGroup already
      // have the id set; this only fires for legacy rows that gained
      // federated members before the column existed.
      let federationGroupId = await getFederationGroupId(input.dmChannelId);
      if (!federationGroupId) {
        federationGroupId = await assignFederationGroupIdIfNeeded(
          input.dmChannelId
        );
        if (federationGroupId) {
          void announceFederatedGroupCreate(input.dmChannelId, ctx.userId);
        }
      }

      if (!federationGroupId) {
        logger.warn(
          '[distributeDmSenderKeys] channel %s has federated recipients but federationGroupId could not be assigned',
          input.dmChannelId
        );
      } else {
        for (const d of federatedDists) {
          void relayFederatedSkdm({
            federationGroupId,
            senderKeyId: input.senderKeyId,
            fromUserId: ctx.userId,
            toUserId: d.toUserId,
            distributionMessage: d.distributionMessage
          });
        }
      }
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
