import { ServerEvents } from '@pulse/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  e2eeSenderKeys,
  userIdentityKeys,
  userKeyBackups,
  userOneTimePreKeys,
  userSignedPreKeys
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure, t } from '../../utils/trpc';
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
      try {
        await insertIdentityResetMessages(ctx.userId);
      } catch (err) {
        // Non-fatal: don't block key registration if system messages fail
        console.error('[E2EE] insertIdentityResetMessages failed:', err);
      }

      pubsub.publish(ServerEvents.E2EE_IDENTITY_RESET, {
        userId: ctx.userId
      });
    }
  });

const getPreKeyBundleRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .query(async ({ input }) => {
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
  .query(async ({ input }) => {
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
      toUserId: z.number(),
      distributionMessage: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db.insert(e2eeSenderKeys).values({
      channelId: input.channelId,
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

const distributeSenderKeysBatchRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
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

    await db.insert(e2eeSenderKeys).values(
      input.distributions.map((d) => ({
        channelId: input.channelId,
        fromUserId: ctx.userId,
        toUserId: d.toUserId,
        distributionMessage: d.distributionMessage,
        createdAt: Date.now()
      }))
    );

    for (const d of input.distributions) {
      pubsub.publishFor(
        d.toUserId,
        ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION,
        {
          channelId: input.channelId,
          fromUserId: ctx.userId
        }
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

    const keys = await db
      .select()
      .from(e2eeSenderKeys)
      .where(and(...conditions));

    return keys.map((k) => ({
      id: k.id,
      channelId: k.channelId,
      fromUserId: k.fromUserId,
      distributionMessage: k.distributionMessage
    }));
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
    .select({ encryptedData: userKeyBackups.encryptedData })
    .from(userKeyBackups)
    .where(eq(userKeyBackups.userId, ctx.userId))
    .limit(1);

  return backup ?? null;
});

const hasKeyBackupRoute = protectedProcedure.query(async ({ ctx }) => {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userKeyBackups)
    .where(eq(userKeyBackups.userId, ctx.userId));

  return (result?.count ?? 0) > 0;
});

const onSenderKeyDistributionRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribeFor(
      ctx.userId,
      ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION
    );
  }
);

const onIdentityResetRoute = protectedProcedure.subscription(async () => {
  return pubsub.subscribe(ServerEvents.E2EE_IDENTITY_RESET);
});

export const e2eeRouter = t.router({
  registerKeys: registerKeysRoute,
  getPreKeyBundle: getPreKeyBundleRoute,
  getIdentityPublicKey: getIdentityPublicKeyRoute,
  uploadOneTimePreKeys: uploadOneTimePreKeysRoute,
  getPreKeyCount: getPreKeyCountRoute,
  rotateSignedPreKey: rotateSignedPreKeyRoute,
  distributeSenderKey: distributeSenderKeyRoute,
  distributeSenderKeysBatch: distributeSenderKeysBatchRoute,
  getPendingSenderKeys: getPendingSenderKeysRoute,
  acknowledgeSenderKeys: acknowledgeSenderKeysRoute,
  uploadKeyBackup: uploadKeyBackupRoute,
  getKeyBackup: getKeyBackupRoute,
  hasKeyBackup: hasKeyBackupRoute,
  onSenderKeyDistribution: onSenderKeyDistributionRoute,
  onIdentityReset: onIdentityResetRoute
});
