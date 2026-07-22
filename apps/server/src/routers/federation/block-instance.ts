import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { deleteShadowUsersByInstance } from '../../db/mutations/federation';
import { getFederationInstanceById } from '../../db/queries/federation';
import { federationInstances } from '../../db/schema';
import { invalidateCorsCache } from '../../http/cors';
import { pubsub } from '../../utils/pubsub';
import { instanceOwnerProcedure } from '../../utils/procedures';

const blockInstanceRoute = instanceOwnerProcedure
  .input(
    z.object({
      instanceId: z.number()
    })
  )
  .mutation(async ({ input }) => {

    // Look up domain before blocking so we can include it in the event
    const instance = await getFederationInstanceById(input.instanceId);

    // Delete shadow users from this instance
    await deleteShadowUsersByInstance(input.instanceId);

    // Update status to blocked
    await db
      .update(federationInstances)
      .set({
        status: 'blocked',
        updatedAt: Date.now()
      })
      .where(eq(federationInstances.id, input.instanceId));

    invalidateCorsCache();

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      instanceId: input.instanceId,
      status: 'blocked',
      domain: instance?.domain
    });

    return { success: true };
  });

export { blockInstanceRoute };
