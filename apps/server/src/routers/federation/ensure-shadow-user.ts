import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { findOrCreateShadowUser, syncShadowUserProfile } from '../../db/mutations/federation';
import { federationInstances } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

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

    const shadowUser = await findOrCreateShadowUser(
      instance.id,
      input.remoteUserId,
      input.username,
      undefined,
      input.remotePublicId
    );

    // Sync profile (avatar, banner, bio) from remote instance (fire-and-forget)
    syncShadowUserProfile(shadowUser.id, input.instanceDomain, input.remotePublicId);

    return { localUserId: shadowUser.id };
  });

export { ensureShadowUserRoute };
