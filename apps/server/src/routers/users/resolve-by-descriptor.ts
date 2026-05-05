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
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { findOrCreateShadowUserByPublicId } from '../../db/mutations/federation';
import { federationInstances, users } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const resolveByDescriptorRoute = protectedProcedure
  .input(
    z.object({
      publicId: z.string().min(1),
      instanceDomain: z.string().min(1),
      name: z.string().optional()
    })
  )
  .mutation(async ({ input }) => {
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

    const shadow = await findOrCreateShadowUserByPublicId(
      instance.id,
      input.publicId,
      input.name ?? ''
    );
    return { id: shadow.id };
  });

export { resolveByDescriptorRoute };
