/**
 * Phase E / E1e — resolve a federation-aware user descriptor
 * `(publicId, instanceDomain, name)` to a local user id on this
 * instance. For local users (instanceDomain == our domain), looks
 * up by publicId. For federated users (instanceDomain != our
 * domain), creates a shadow on demand.
 *
 * Called from the client when establishing pairwise sessions for
 * cross-instance channel SKDM distribution. The session needs a
 * stable local id to address with — and for federated peers a
 * shadow may not yet exist on home (the client may have just
 * joined a federated server, with members it has never DM'd).
 *
 * Minting a shadow is a write any authenticated user can trigger, so
 * it is fenced three ways: bounded inputs, a per-caller rate limit on
 * NEW shadows, and a relationship check — the caller must take part in
 * federation (a membership on a federated server, or a friendship with
 * a user of that instance) before this instance grows a shadow row on
 * their say-so.
 */

import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { findOrCreateShadowUserByPublicId } from '../../db/mutations/federation';
import {
  federationInstances,
  friendships,
  userFederatedServers,
  users
} from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// Token bucket per caller, charged only when a shadow is actually
// minted. A member of a large federated server legitimately resolves
// every co-member once (one shadow each) — the burst covers that; the
// sustained rate bounds a looping client to ~100 rows/min.
const MINT_RATE_LIMIT_CAPACITY = 500;
const MINT_RATE_LIMIT_REFILL_PER_MS = 100 / 60_000;
const MINT_BUCKET_IDLE_MS = 60 * 60 * 1000;
const MINT_BUCKET_PRUNE_THRESHOLD = 1024;

type MintBucket = { tokens: number; lastRefillAt: number };
const mintBuckets = new Map<number, MintBucket>();

/** Test hook — the map is module state the between-test TRUNCATE never sees. */
const _resetResolveByDescriptorRateLimit = (): void => {
  mintBuckets.clear();
};

const tryConsumeMintToken = (userId: number, now = Date.now()): boolean => {
  let bucket = mintBuckets.get(userId);
  if (!bucket) {
    bucket = { tokens: MINT_RATE_LIMIT_CAPACITY, lastRefillAt: now };
    mintBuckets.set(userId, bucket);
  } else {
    bucket.tokens = Math.min(
      MINT_RATE_LIMIT_CAPACITY,
      bucket.tokens + (now - bucket.lastRefillAt) * MINT_RATE_LIMIT_REFILL_PER_MS
    );
    bucket.lastRefillAt = now;
  }

  if (mintBuckets.size > MINT_BUCKET_PRUNE_THRESHOLD) {
    for (const [k, b] of mintBuckets) {
      if (now - b.lastRefillAt > MINT_BUCKET_IDLE_MS) mintBuckets.delete(k);
    }
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
};

/**
 * Whether `userId` has a federation relationship that justifies minting
 * a shadow for a user of `instanceId`:
 *   - a membership on a federated server (the descriptor came from a
 *     channel roster the caller can see; the roster's host may be a
 *     third instance, so any federated membership qualifies), or
 *   - a friendship with an existing shadow of that instance.
 */
const canMintShadowFor = async (
  userId: number,
  instanceId: number
): Promise<boolean> => {
  const [membership] = await db
    .select({ id: userFederatedServers.id })
    .from(userFederatedServers)
    .where(eq(userFederatedServers.userId, userId))
    .limit(1);
  if (membership) return true;

  const [friend] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .innerJoin(
      users,
      or(
        and(eq(friendships.userId, userId), eq(users.id, friendships.friendId)),
        and(eq(friendships.friendId, userId), eq(users.id, friendships.userId))
      )
    )
    .where(eq(users.federatedInstanceId, instanceId))
    .limit(1);
  return !!friend;
};

const resolveByDescriptorRoute = protectedProcedure
  .input(
    z.object({
      publicId: z.string().min(1).max(64),
      instanceDomain: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-z0-9.-]+(:\d{1,5})?$/i, 'Invalid instance domain'),
      // Same cap as users.update — a shadow's display name is a user name.
      name: z.string().max(24).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.instanceDomain === config.federation.domain) {
      // Local user — look up by publicId.
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.publicId, input.publicId))
        .limit(1);
      return { id: user?.id ?? null };
    }

    // Federated user — resolve to (or create) the shadow on home.
    const [instance] = await db
      .select({ id: federationInstances.id, status: federationInstances.status })
      .from(federationInstances)
      .where(eq(federationInstances.domain, input.instanceDomain))
      .limit(1);
    if (!instance || instance.status !== 'active') {
      return { id: null };
    }

    const [existingShadow] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, instance.id),
          eq(users.federatedPublicId, input.publicId)
        )
      )
      .limit(1);

    if (!existingShadow) {
      invariant(await canMintShadowFor(ctx.userId, instance.id), {
        code: 'FORBIDDEN',
        message: 'No federation relationship with that instance'
      });
      invariant(tryConsumeMintToken(ctx.userId), {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many federated users resolved — try again later.'
      });
    }

    const shadow = await findOrCreateShadowUserByPublicId(
      instance.id,
      input.publicId,
      input.name ?? ''
    );
    return { id: shadow.id };
  });

export { _resetResolveByDescriptorRateLimit, resolveByDescriptorRoute };
