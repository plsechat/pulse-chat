import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { config } from '../../config';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { enqueueRelay } from '../../utils/federation-outbox';
import { fetchPeerVersion } from '../../utils/federation-peer-version';
import { pubsub } from '../../utils/pubsub';
import { invalidateCorsCache } from '../../http/cors';

const acceptInstanceRoute = instanceOwnerProcedure
  .input(
    z.object({
      instanceId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {

    const [instance] = await db
      .select()
      .from(federationInstances)
      .where(eq(federationInstances.id, input.instanceId))
      .limit(1);

    if (!instance) {
      ctx.throwValidationError('instanceId', 'Instance not found');
    }

    if (instance!.status === 'blocked') {
      ctx.throwValidationError('instanceId', 'Instance is blocked');
    }

    // The peer's advertised version, captured while we are talking to
    // it anyway; null when /federation/info is unreachable right now.
    const peerVersion = await fetchPeerVersion(instance!.domain);

    // Update local record to active + mutual
    await db
      .update(federationInstances)
      .set({
        status: 'active',
        direction: 'mutual',
        ...(peerVersion !== null ? { peerVersion } : {}),
        updatedAt: Date.now()
      })
      .where(eq(federationInstances.id, input.instanceId));

    // Tell the peer. Through the outbox (the row is active now, so it
    // queues): a peer mid-restart gets the acceptance when it is back
    // instead of staying pending on its side forever. The body names us
    // as `domain` like it always did; the relay adds `fromDomain` and
    // the receiver verifies the whole signed body.
    void enqueueRelay(instance!.domain, '/federation/accept', {
      domain: config.federation.domain
    });

    invalidateCorsCache();

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      domain: instance!.domain,
      status: 'active'
    });

    return { success: true };
  });

export { acceptInstanceRoute };
