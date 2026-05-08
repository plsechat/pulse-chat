import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { findOrCreateShadowUser, syncShadowUserProfile } from '../../db/mutations/federation';
import { federationInstances } from '../../db/schema';
import { signChallenge } from '../../utils/federation';
import { federationFetch } from '../../utils/federation-fetch';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { getFederationProtocol } from '../../utils/validate-url';

const ensureShadowUserRoute = protectedProcedure
  .input(
    z.object({
      instanceDomain: z.string(),
      remoteUserId: z.number(),
      username: z.string(),
      remotePublicId: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // Only local (non-federated) users should call this — they need to resolve
    // remote users to local shadow IDs when viewing federated server content.
    invariant(!ctx.user?.isFederated, {
      code: 'FORBIDDEN',
      message: 'Federated users cannot create shadow users'
    });
    const [instance] = await db
      .select()
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, input.instanceDomain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);

    invariant(instance, {
      code: 'NOT_FOUND',
      message: 'Federation instance not found'
    });

    // F5: verify the user actually exists on the named federated
    // instance BEFORE creating a shadow record. Without this, any
    // local user could spam shadow records with arbitrary
    // publicId/username pairs and create misleading shadows that
    // never line up with a real remote user. We fetch user-info
    // from the remote (signed with our federation key) and accept
    // the remote's `name` as authoritative — the caller's
    // `username` is only used as a fallback if the remote doesn't
    // respond and we already had a shadow we wouldn't recreate
    // anyway.
    const protocol = getFederationProtocol(input.instanceDomain);
    const bodyToSign = {
      publicId: input.remotePublicId,
      fromDomain: config.federation.domain
    };
    const signature = await signChallenge(bodyToSign, input.instanceDomain);

    let verifiedName: string | undefined;
    try {
      const infoResponse = await federationFetch(
        `${protocol}://${input.instanceDomain}/federation/user-info`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...bodyToSign,
            signature
          }),
          signal: AbortSignal.timeout(10_000)
        }
      );

      invariant(infoResponse.ok, {
        code: 'NOT_FOUND',
        message: 'Remote user not found on federated instance'
      });

      const profile = (await infoResponse.json()) as {
        name?: string;
      };
      invariant(profile.name, {
        code: 'NOT_FOUND',
        message: 'Remote user-info missing name'
      });
      verifiedName = profile.name;
    } catch (err) {
      // Re-throw TRPCError-style invariant rejections; wrap others.
      if (err && typeof err === 'object' && 'code' in err) throw err;
      throw new Error(
        `Failed to verify remote user on ${input.instanceDomain}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const shadowUser = await findOrCreateShadowUser(
      instance.id,
      input.remoteUserId,
      verifiedName,
      undefined,
      input.remotePublicId
    );

    // Sync profile (avatar, banner, bio) from remote instance (fire-and-forget)
    syncShadowUserProfile(shadowUser.id, input.instanceDomain, input.remotePublicId);

    return { localUserId: shadowUser.id };
  });

export { ensureShadowUserRoute };
