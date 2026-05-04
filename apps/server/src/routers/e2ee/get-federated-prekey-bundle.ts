import { z } from 'zod';
import { config } from '../../config';
import { queryInstance } from '../../utils/federation';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Fetch a pre-key bundle for a user on a federated peer instance.
 * Phase D / D1.
 *
 * Calls the remote peer's `POST /federation/get-prekey-bundle` via
 * `queryInstance`, which signs the request and verifies the signed
 * response against the peer's stored federation public key. Returns
 * the verified bundle on success, or `null` on any failure (peer
 * offline, signature invalid, peer unknown, target user not found,
 * pool exhausted with no signed pre-key, etc).
 *
 * The route is intentionally minimal — no application-level
 * authorization beyond `protectedProcedure`. Federation hardening
 * (peer rate-limit, DNS revalidation, body cap, signature
 * verification) is layered in the underlying helpers. The peer side
 * separately enforces a per-publicId rate limit to protect its OTPK
 * pools.
 *
 * Returned shape mirrors the same-instance `e2ee.getPreKeyBundle`
 * route plus a `fromDomain` field that the response signature is
 * bound to (the responding instance's own domain). Callers can
 * ignore `fromDomain`; it's there so the verifier had something to
 * commit to as part of the digest.
 */
const getFederatedPreKeyBundleRoute = protectedProcedure
  .input(
    z.object({
      instanceDomain: z.string().min(1),
      targetPublicId: z.string().min(1)
    })
  )
  .query(async ({ input }) => {
    if (!config.federation.enabled) {
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
      input.instanceDomain,
      '/federation/get-prekey-bundle',
      { targetPublicId: input.targetPublicId }
    );

    return result;
  });

export { getFederatedPreKeyBundleRoute };
