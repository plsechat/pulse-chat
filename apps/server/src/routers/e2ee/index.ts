import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import {
  channels,
  e2eeSenderKeys,
  federationInstances,
  serverMembers,
  userIdentityKeys,
  userKeyBackups,
  userOneTimePreKeys,
  userSignedPreKeys,
  users
} from '../../db/schema';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getCoMemberIds } from '../../db/queries/servers';
import { logger } from '../../logger';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { relayFederatedChannelSenderKeyNotifications } from '../../utils/federation-channel-sender-key-dispatch';
import { relayFederatedIdentityRotation } from '../../utils/federation-dm-group-dispatch';
import { protectedProcedure, t } from '../../utils/trpc';
import { getFederatedPreKeyBundleRoute } from './get-federated-prekey-bundle';
import { insertIdentityResetMessages } from './identity-reset-messages';

const registerKeysRoute = protectedProcedure
  .input(
    z.object({
      identityPublicKey: z.string(),
      registrationId: z.number(),
      signedPreKey: z.object({
        keyId: z.number(),
        publicKey: z.string(),
        signature: z.string()
      }),
      oneTimePreKeys: z.array(
        z.object({
          keyId: z.number(),
          publicKey: z.string()
        })
      )
    })
  )
  .mutation(async ({ ctx, input }) => {
    const now = Date.now();
    let identityChanged = false;

    await db.transaction(async (tx) => {
      // Check if identity key is changing (key reset detection)
      const [existing] = await tx
        .select({ identityPublicKey: userIdentityKeys.identityPublicKey })
        .from(userIdentityKeys)
        .where(eq(userIdentityKeys.userId, ctx.userId))
        .limit(1);

      identityChanged = !!(
        existing && existing.identityPublicKey !== input.identityPublicKey
      );

      // Upsert identity key
      await tx
        .insert(userIdentityKeys)
        .values({
          userId: ctx.userId,
          identityPublicKey: input.identityPublicKey,
          registrationId: input.registrationId,
          createdAt: now
        })
        .onConflictDoUpdate({
          target: userIdentityKeys.userId,
          set: {
            identityPublicKey: input.identityPublicKey,
            registrationId: input.registrationId
          }
        });

      // Clear existing signed pre-keys and one-time pre-keys (for key regeneration)
      await tx
        .delete(userSignedPreKeys)
        .where(eq(userSignedPreKeys.userId, ctx.userId));
      await tx
        .delete(userOneTimePreKeys)
        .where(eq(userOneTimePreKeys.userId, ctx.userId));

      // Insert signed pre-key
      await tx.insert(userSignedPreKeys).values({
        userId: ctx.userId,
        keyId: input.signedPreKey.keyId,
        publicKey: input.signedPreKey.publicKey,
        signature: input.signedPreKey.signature,
        createdAt: now
      });

      // Insert one-time pre-keys
      if (input.oneTimePreKeys.length > 0) {
        await tx.insert(userOneTimePreKeys).values(
          input.oneTimePreKeys.map((key) => ({
            userId: ctx.userId,
            keyId: key.keyId,
            publicKey: key.publicKey,
            createdAt: now
          }))
        );
      }

      // On identity change: delete all sender key distributions involving
      // this user — they were encrypted with the old identity and are now
      // undecryptable. Fresh distributions will be created on reconnect.
      if (identityChanged) {
        await tx.delete(e2eeSenderKeys).where(
          or(
            eq(e2eeSenderKeys.fromUserId, ctx.userId),
            eq(e2eeSenderKeys.toUserId, ctx.userId)
          )
        );
      }
    });

    // Insert system messages and broadcast identity reset after transaction commits
    if (identityChanged) {
      logger.debug(
        '[E2EE/registerKeys] identity rotated userId=%d',
        ctx.userId
      );
      try {
        await insertIdentityResetMessages(ctx.userId);
      } catch (err) {
        // Non-fatal: don't block key registration if system messages fail
        logger.error('[E2EE] insertIdentityResetMessages failed: %o', err);
      }

      const coMemberIds = await getCoMemberIds(ctx.userId);
      pubsub.publishFor(coMemberIds, ServerEvents.E2EE_IDENTITY_RESET, {
        userId: ctx.userId
      });

      // Phase D / D3 — propagate to federated DM peers. Active-DM-
      // channels-only scope; channel rotation propagation is out of
      // scope for Phase D (federation v3 territory).
      void relayFederatedIdentityRotation({
        rotatingUserId: ctx.userId,
        newIdentityPublicKey: input.identityPublicKey
      });
    }
  });

const getPreKeyBundleRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .query(async ({ ctx, input }) => {
    // Verify the caller shares at least one server with the target user
    const callerServers = db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(eq(serverMembers.userId, ctx.userId));

    const [shared] = await db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.userId, input.userId),
          sql`${serverMembers.serverId} IN (${callerServers})`
        )
      )
      .limit(1);

    invariant(shared, {
      code: 'FORBIDDEN',
      message: 'No shared server with target user'
    });

    // Get identity key
    const [identityKey] = await db
      .select()
      .from(userIdentityKeys)
      .where(eq(userIdentityKeys.userId, input.userId))
      .limit(1);

    if (!identityKey) {
      return null;
    }

    // Get latest signed pre-key
    const [signedPreKey] = await db
      .select()
      .from(userSignedPreKeys)
      .where(eq(userSignedPreKeys.userId, input.userId))
      .orderBy(sql`${userSignedPreKeys.createdAt} DESC`)
      .limit(1);

    if (!signedPreKey) {
      return null;
    }

    // Consume one one-time pre-key (fetch + delete atomically)
    const [oneTimePreKey] = await db
      .delete(userOneTimePreKeys)
      .where(
        eq(
          userOneTimePreKeys.id,
          db
            .select({ id: userOneTimePreKeys.id })
            .from(userOneTimePreKeys)
            .where(eq(userOneTimePreKeys.userId, input.userId))
            .orderBy(sql`${userOneTimePreKeys.createdAt} ASC`)
            .limit(1)
        )
      )
      .returning();

    return {
      identityPublicKey: identityKey.identityPublicKey,
      registrationId: identityKey.registrationId,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature
      },
      oneTimePreKey: oneTimePreKey
        ? {
            keyId: oneTimePreKey.keyId,
            publicKey: oneTimePreKey.publicKey
          }
        : null
    };
  });

const getIdentityPublicKeyRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .query(async ({ ctx, input }) => {
    // Verify the caller shares at least one server with the target user
    const callerServers = db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(eq(serverMembers.userId, ctx.userId));

    const [shared] = await db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.userId, input.userId),
          sql`${serverMembers.serverId} IN (${callerServers})`
        )
      )
      .limit(1);

    invariant(shared, {
      code: 'FORBIDDEN',
      message: 'No shared server with target user'
    });

    const [key] = await db
      .select({ identityPublicKey: userIdentityKeys.identityPublicKey })
      .from(userIdentityKeys)
      .where(eq(userIdentityKeys.userId, input.userId))
      .limit(1);

    return key?.identityPublicKey ?? null;
  });

const uploadOneTimePreKeysRoute = protectedProcedure
  .input(
    z.object({
      oneTimePreKeys: z.array(
        z.object({
          keyId: z.number(),
          publicKey: z.string()
        })
      )
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.oneTimePreKeys.length === 0) return;

    await db.insert(userOneTimePreKeys).values(
      input.oneTimePreKeys.map((key) => ({
        userId: ctx.userId,
        keyId: key.keyId,
        publicKey: key.publicKey,
        createdAt: Date.now()
      }))
    );
  });

// Identity reset and key restore must redistribute sender keys to every
// E2EE channel the caller can VIEW across every server they're in — not
// just the active server (the previous behavior, which left peers in
// other servers stuck on stale keys until manual rotation). The result
// is a flat number[] of channel ids; the client iterates and calls
// ensureChannelSenderKey on each.
const listMyE2eeChannelIdsRoute = protectedProcedure.query(async ({ ctx }) => {
  // Pull every e2ee channel id and ask the existing visibility query
  // which ones the caller can view. This re-uses the channel-permission
  // logic (private + per-user overrides + role permissions) instead of
  // duplicating it, at the cost of N small queries on identity reset.
  // Reset happens rarely; the cost is acceptable.
  const e2eeChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.e2ee, true));

  const visible: number[] = [];
  for (const ch of e2eeChannels) {
    const userIds = await getAffectedUserIdsForChannel(ch.id, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    if (userIds.includes(ctx.userId)) visible.push(ch.id);
  }
  return visible;
});

const getPreKeyCountRoute = protectedProcedure.query(async ({ ctx }) => {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userOneTimePreKeys)
    .where(eq(userOneTimePreKeys.userId, ctx.userId));

  return result?.count ?? 0;
});

const rotateSignedPreKeyRoute = protectedProcedure
  .input(
    z.object({
      keyId: z.number(),
      publicKey: z.string(),
      signature: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db.insert(userSignedPreKeys).values({
      userId: ctx.userId,
      keyId: input.keyId,
      publicKey: input.publicKey,
      signature: input.signature,
      createdAt: Date.now()
    });
  });

const distributeSenderKeyRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      // Phase B: bumps on every chain rotation. Defaults to 1 so any
      // pre-Phase-B clients still in the wild keep working until they
      // upgrade — and there's no clean way to make this `required`
      // without breaking the wire-compat split with their bundles.
      senderKeyId: z.number().int().min(1).default(1),
      toUserId: z.number(),
      distributionMessage: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // Verify the caller has access to this channel
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    await db.insert(e2eeSenderKeys).values({
      channelId: input.channelId,
      senderKeyId: input.senderKeyId,
      fromUserId: ctx.userId,
      toUserId: input.toUserId,
      distributionMessage: input.distributionMessage,
      createdAt: Date.now()
    });

    pubsub.publishFor(
      input.toUserId,
      ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION,
      {
        channelId: input.channelId,
        fromUserId: ctx.userId
      }
    );
  });

// Phase E / E1b — distribution targets accept either the legacy
// numeric `toUserId` shape or the new (toPublicId, toInstanceDomain)
// shape. PublicId-keyed targets let federated members on other
// instances be addressed without an active-server-local id; the
// receiving instance gets a federation notification (Decision 1,
// Option A: host-only SKDM storage with notify-on-availability).
const distributionTargetSchema = z.union([
  z.object({
    toUserId: z.number(),
    distributionMessage: z.string()
  }),
  z.object({
    toPublicId: z.string().min(1),
    toInstanceDomain: z.string().optional(),
    distributionMessage: z.string()
  })
]);

const distributeSenderKeysBatchRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      senderKeyId: z.number().int().min(1).default(1),
      distributions: z.array(distributionTargetSchema)
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.distributions.length === 0) return;

    // Verify the caller has access to this channel
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    // Resolve each distribution target to a local user id (real for
    // non-federated, shadow for federated). Collect federated targets
    // separately so we can fire one notification per peer instance
    // after the local DB write commits.
    const insertRows: {
      channelId: number;
      senderKeyId: number;
      fromUserId: number;
      toUserId: number;
      distributionMessage: string;
      createdAt: number;
    }[] = [];
    const localPubsubTargets: number[] = [];
    const federatedTargets: { toPublicId: string; toInstanceDomain: string }[] = [];
    const now = Date.now();

    for (const d of input.distributions) {
      let resolvedUserId: number | null = null;
      let federatedDomain: string | null = null;
      let federatedPublicId: string | null = null;

      if ('toUserId' in d) {
        resolvedUserId = d.toUserId;
      } else {
        const toInstanceDomain = d.toInstanceDomain;
        const isLocalTarget =
          !toInstanceDomain || toInstanceDomain === config.federation.domain;

        if (isLocalTarget) {
          // Local user — resolve by publicId.
          const [user] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.publicId, d.toPublicId))
            .limit(1);
          if (user) {
            resolvedUserId = user.id;
          }
        } else {
          // Federated user — resolve to the shadow user on this host
          // by (federatedInstanceDomain, federatedPublicId).
          const [peerInstance] = await db
            .select({ id: federationInstances.id })
            .from(federationInstances)
            .where(eq(federationInstances.domain, toInstanceDomain))
            .limit(1);
          if (peerInstance) {
            const [shadow] = await db
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.federatedInstanceId, peerInstance.id),
                  eq(users.federatedPublicId, d.toPublicId)
                )
              )
              .limit(1);
            if (shadow) {
              resolvedUserId = shadow.id;
              federatedDomain = toInstanceDomain;
              federatedPublicId = d.toPublicId;
            }
          }
        }
      }

      if (resolvedUserId === null) {
        logger.warn(
          '[distributeSenderKeysBatch] could not resolve target — skipping'
        );
        continue;
      }

      insertRows.push({
        channelId: input.channelId,
        senderKeyId: input.senderKeyId,
        fromUserId: ctx.userId,
        toUserId: resolvedUserId,
        distributionMessage: d.distributionMessage,
        createdAt: now
      });

      if (federatedDomain && federatedPublicId) {
        // Federated recipient — they get a federation notification
        // on their *home* (E1c). We deliberately do NOT fire local
        // pubsub for the shadow user id: even when the federated
        // user is connected to this host via a federation token,
        // the existing E2EE_SENDER_KEY_DISTRIBUTION handler runs
        // against the host's active store, which doesn't have
        // their private keys (those live on home). The federation
        // notification path routes them through the right store.
        federatedTargets.push({
          toPublicId: federatedPublicId,
          toInstanceDomain: federatedDomain
        });
      } else {
        localPubsubTargets.push(resolvedUserId);
      }
    }

    if (insertRows.length === 0) return;

    await db.insert(e2eeSenderKeys).values(insertRows);
    logger.debug(
      '[distributeSenderKeysBatch] channelId=%d senderKeyId=%d local=%d federated=%d',
      input.channelId,
      input.senderKeyId,
      localPubsubTargets.length,
      federatedTargets.length
    );

    for (const userId of localPubsubTargets) {
      pubsub.publishFor(userId, ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION, {
        channelId: input.channelId,
        fromUserId: ctx.userId
      });
    }

    if (federatedTargets.length > 0) {
      // Fire-and-forget per peer; one failure doesn't block local
      // recipients from receiving their pubsub.
      relayFederatedChannelSenderKeyNotifications({
        channelId: input.channelId,
        fromUserId: ctx.userId,
        senderKeyId: input.senderKeyId,
        targets: federatedTargets
      }).catch((err) =>
        logger.error(
          '[distributeSenderKeysBatch] federation relay failed: %o',
          err
        )
      );
    }
  });

const getPendingSenderKeysRoute = protectedProcedure
  .input(z.object({ channelId: z.number().optional() }))
  .query(async ({ ctx, input }) => {
    const conditions = [eq(e2eeSenderKeys.toUserId, ctx.userId)];

    if (input.channelId) {
      conditions.push(eq(e2eeSenderKeys.channelId, input.channelId));
    }

    // Phase E / E1f — federated recipients fetch their own SKDMs
    // by connecting to the host as their shadow user. Decryption
    // happens against the recipient's *home* signal store, which
    // requires resolving the sender to a home-local id. We surface
    // the sender's home publicId + instance domain alongside each
    // row so the client doesn't need a second round-trip just to
    // figure out who sent it. For local senders, fromInstanceDomain
    // is null (means "this host" — receiver collapses to ownDomain).
    // Pre-E1 callers ignore the new fields.
    const keys = await db
      .select({
        id: e2eeSenderKeys.id,
        channelId: e2eeSenderKeys.channelId,
        senderKeyId: e2eeSenderKeys.senderKeyId,
        fromUserId: e2eeSenderKeys.fromUserId,
        distributionMessage: e2eeSenderKeys.distributionMessage,
        fromIsFederated: users.isFederated,
        fromUserPublicId: users.publicId,
        fromFederatedPublicId: users.federatedPublicId,
        fromFederatedInstanceId: users.federatedInstanceId
      })
      .from(e2eeSenderKeys)
      .innerJoin(users, eq(users.id, e2eeSenderKeys.fromUserId))
      .where(and(...conditions));

    if (keys.length === 0) return [];

    const fedInstanceIds = Array.from(
      new Set(
        keys
          .filter((k) => k.fromIsFederated && k.fromFederatedInstanceId)
          .map((k) => k.fromFederatedInstanceId as number)
      )
    );

    const domainById = new Map<number, string>();
    if (fedInstanceIds.length > 0) {
      const rows = await db
        .select({
          id: federationInstances.id,
          domain: federationInstances.domain
        })
        .from(federationInstances)
        .where(inArray(federationInstances.id, fedInstanceIds));
      for (const r of rows) domainById.set(r.id, r.domain);
    }

    return keys.map((k) => {
      let fromHomePublicId: string | null = null;
      let fromInstanceDomain: string | null = null;

      if (k.fromIsFederated && k.fromFederatedInstanceId) {
        fromHomePublicId = k.fromFederatedPublicId ?? null;
        fromInstanceDomain = domainById.get(k.fromFederatedInstanceId) ?? null;
      } else {
        fromHomePublicId = k.fromUserPublicId ?? null;
        fromInstanceDomain = null; // collapses to "this host" on the wire
      }

      return {
        id: k.id,
        channelId: k.channelId,
        senderKeyId: k.senderKeyId,
        fromUserId: k.fromUserId,
        distributionMessage: k.distributionMessage,
        fromHomePublicId,
        fromInstanceDomain
      };
    });
  });

const acknowledgeSenderKeysRoute = protectedProcedure
  .input(z.object({ ids: z.array(z.number()) }))
  .mutation(async ({ ctx, input }) => {
    if (input.ids.length === 0) return;

    await db
      .delete(e2eeSenderKeys)
      .where(
        and(
          eq(e2eeSenderKeys.toUserId, ctx.userId),
          sql`${e2eeSenderKeys.id} IN (${sql.join(input.ids.map((id) => sql`${id}`), sql`, `)})`
        )
      );
  });

const uploadKeyBackupRoute = protectedProcedure
  .input(z.object({ encryptedData: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const now = Date.now();
    await db
      .insert(userKeyBackups)
      .values({
        userId: ctx.userId,
        encryptedData: input.encryptedData,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: userKeyBackups.userId,
        set: {
          encryptedData: input.encryptedData,
          updatedAt: now
        }
      });
  });

const getKeyBackupRoute = protectedProcedure.query(async ({ ctx }) => {
  const [backup] = await db
    .select({
      encryptedData: userKeyBackups.encryptedData,
      updatedAt: userKeyBackups.updatedAt
    })
    .from(userKeyBackups)
    .where(eq(userKeyBackups.userId, ctx.userId))
    .limit(1);

  return backup ?? null;
});

const hasKeyBackupRoute = protectedProcedure.query(async ({ ctx }) => {
  const [result] = await db
    .select({ updatedAt: userKeyBackups.updatedAt })
    .from(userKeyBackups)
    .where(eq(userKeyBackups.userId, ctx.userId))
    .limit(1);

  return result ? { exists: true as const, updatedAt: result.updatedAt } : { exists: false as const };
});

const onSenderKeyDistributionRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION
    );
  }
);

// Phase E / E1f — fired on the receiver's *home* instance when one
// of its local users is a recipient of a fresh SKDM stored on a
// federated host. Client subscribes on home; on receipt it opens
// or reuses the active-server tRPC to `hostDomain` to fetch and
// decrypt the SKDM.
const onFederatedSenderKeyAvailableRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.E2EE_FEDERATED_SENDER_KEY_AVAILABLE
    );
  }
);

const onIdentityResetRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return pubsub.subscribeFor(ctx.userId, ServerEvents.E2EE_IDENTITY_RESET);
  }
);

export const e2eeRouter = t.router({
  registerKeys: registerKeysRoute,
  getPreKeyBundle: getPreKeyBundleRoute,
  getFederatedPreKeyBundle: getFederatedPreKeyBundleRoute,
  getIdentityPublicKey: getIdentityPublicKeyRoute,
  uploadOneTimePreKeys: uploadOneTimePreKeysRoute,
  getPreKeyCount: getPreKeyCountRoute,
  rotateSignedPreKey: rotateSignedPreKeyRoute,
  listMyE2eeChannelIds: listMyE2eeChannelIdsRoute,
  distributeSenderKey: distributeSenderKeyRoute,
  distributeSenderKeysBatch: distributeSenderKeysBatchRoute,
  getPendingSenderKeys: getPendingSenderKeysRoute,
  acknowledgeSenderKeys: acknowledgeSenderKeysRoute,
  uploadKeyBackup: uploadKeyBackupRoute,
  getKeyBackup: getKeyBackupRoute,
  hasKeyBackup: hasKeyBackupRoute,
  onSenderKeyDistribution: onSenderKeyDistributionRoute,
  onFederatedSenderKeyAvailable: onFederatedSenderKeyAvailableRoute,
  onIdentityReset: onIdentityResetRoute
});
