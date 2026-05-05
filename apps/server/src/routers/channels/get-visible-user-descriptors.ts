import { ChannelPermission } from '@pulse/shared';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { federationInstances, users } from '../../db/schema';
import { config } from '../../config';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Phase E / E1e — descriptors variant of getVisibleUsers, returning
 * each member with the federation-aware fields needed for cross-
 * instance E2EE addressing:
 *
 *   - id            local user id (host's view)
 *   - publicId      stable cross-instance identifier
 *   - instanceDomain home of the user (this host's domain for local
 *                    users, the federated user's home for shadows)
 *
 * Permission semantics match getVisibleUsers — same caller permission
 * check, same `getAffectedUserIdsForChannel` query. The federated
 * SKDM dispatch (E1b/c/d) uses `(publicId, instanceDomain)` to address
 * recipients, so it can't use the bare-id route.
 */
const getVisibleUserDescriptorsRoute = protectedProcedure
  .input(z.object({ channelId: z.number() }))
  .query(async ({ input, ctx }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const userIds = await getAffectedUserIdsForChannel(input.channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });

    if (userIds.length === 0) return [];

    const memberRows = await db
      .select({
        id: users.id,
        publicId: users.publicId,
        federatedPublicId: users.federatedPublicId,
        isFederated: users.isFederated,
        federatedInstanceId: users.federatedInstanceId
      })
      .from(users)
      .where(inArray(users.id, userIds));

    // Resolve federation_instance_id → domain in one batch.
    const federatedInstanceIds = Array.from(
      new Set(
        memberRows
          .filter((m) => m.isFederated && m.federatedInstanceId)
          .map((m) => m.federatedInstanceId as number)
      )
    );

    const domainById = new Map<number, string>();
    if (federatedInstanceIds.length > 0) {
      const rows = await db
        .select({
          id: federationInstances.id,
          domain: federationInstances.domain
        })
        .from(federationInstances)
        .where(inArray(federationInstances.id, federatedInstanceIds));
      for (const r of rows) domainById.set(r.id, r.domain);
    }

    const descriptors: {
      id: number;
      publicId: string;
      instanceDomain: string;
    }[] = [];

    for (const m of memberRows) {
      let publicId: string | null;
      let instanceDomain: string;

      if (m.isFederated && m.federatedInstanceId) {
        const domain = domainById.get(m.federatedInstanceId);
        if (!domain) continue; // peer instance not in our table — skip
        publicId = m.federatedPublicId ?? m.publicId;
        instanceDomain = domain;
      } else {
        publicId = m.publicId;
        instanceDomain = config.federation.domain;
      }

      // Drop members without a publicId — they can't be addressed
      // for federated SKDM. Backfill happens at boot
      // (db/index.ts), so this is rare.
      if (!publicId) continue;

      descriptors.push({
        id: m.id,
        publicId,
        instanceDomain
      });
    }

    return descriptors;
  });

export { getVisibleUserDescriptorsRoute };
