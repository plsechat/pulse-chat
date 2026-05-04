import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { federationInstances, users } from '../../db/schema';
import { queryInstance } from '../../utils/federation';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Fetch a pre-key bundle for a federated user. Phase D / D1.
 *
 * Input is the local shadow-user id, which the home server resolves
 * into the federated identifiers (`federatedInstanceId` →
 * `instanceDomain`, `federatedPublicId`) before calling the peer's
 * `POST /federation/get-prekey-bundle` via `queryInstance`. The
 * response is signature-verified against the peer's stored
 * federation public key (Phase D / D0).
 *
 * Returns the verified bundle on success, or `null` on any failure
 * (peer offline, signature invalid, peer unknown, target user has
 * no bundle, target is not actually a federated user, etc.). Per
 * Decision 2, the caller surfaces null as a hard "encrypted DM
 * unavailable" failure — there is no silent fallback to plaintext.
 *
 * Returned shape mirrors the same-instance `e2ee.getPreKeyBundle`
 * route plus a `fromDomain` field that the response signature is
 * bound to. Callers can ignore `fromDomain`; it's present so the
 * verifier had something to commit to as part of the digest.
 */
const getFederatedPreKeyBundleRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .query(async ({ input }) => {
    if (!config.federation.enabled) {
      return null;
    }

    const [user] = await db
      .select({
        isFederated: users.isFederated,
        federatedInstanceId: users.federatedInstanceId,
        federatedPublicId: users.federatedPublicId
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    if (
      !user?.isFederated ||
      !user.federatedInstanceId ||
      !user.federatedPublicId
    ) {
      return null;
    }

    const [instance] = await db
      .select({
        domain: federationInstances.domain,
        status: federationInstances.status
      })
      .from(federationInstances)
      .where(eq(federationInstances.id, user.federatedInstanceId))
      .limit(1);

    if (!instance || instance.status !== 'active') {
      return null;
    }

    type FederatedBundle = {
      identityPublicKey: string;
      registrationId: number;
      signedPreKey: {
        keyId: number;
        publicKey: string;
        signature: string;
      };
      oneTimePreKey: {
        keyId: number;
        publicKey: string;
      } | null;
      fromDomain: string;
      [key: string]: unknown;
    };

    const result = await queryInstance<FederatedBundle>(
      instance.domain,
      '/federation/get-prekey-bundle',
      { targetPublicId: user.federatedPublicId }
    );

    return result;
  });

export { getFederatedPreKeyBundleRoute };
