import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { deleteShadowUsersByInstance } from '../../db/mutations/federation';
import { getFederationInstanceById } from '../../db/queries/federation';
import { federationInstances } from '../../db/schema';
import { invalidateCorsCache } from '../../http/cors';
import { relayUnpeer } from '../../utils/federation-unpeer-dispatch';
import { pubsub } from '../../utils/pubsub';
import { instanceOwnerProcedure } from '../../utils/procedures';

const removeInstanceRoute = instanceOwnerProcedure
  .input(
    z.object({
      instanceId: z.number().int().positive()
    })
  )
  .mutation(async ({ input }) => {

    // Look up domain before deleting so we can include it in the event
    const instance = await getFederationInstanceById(input.instanceId);

    // Tell the peer first — once the row is gone we can no longer sign
    // for its audience or address it.
    if (instance?.status === 'active') {
      await relayUnpeer(instance.domain, 'removed');
    }

    // Delete shadow users from this instance (and the DM channels they
    // leave behind — see deleteShadowUsersByInstance)
    await deleteShadowUsersByInstance(input.instanceId);

    // Delete the instance record (federation_outbox rows cascade)
    await db
      .delete(federationInstances)
      .where(eq(federationInstances.id, input.instanceId));

    invalidateCorsCache();

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      instanceId: input.instanceId,
      status: 'removed',
      domain: instance?.domain
    });

    return { success: true };
  });

export { removeInstanceRoute };
