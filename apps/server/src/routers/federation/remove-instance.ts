import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { deleteShadowUsersByInstance } from '../../db/mutations/federation';
import { getFederationInstanceById } from '../../db/queries/federation';
import { getFirstServer } from '../../db/queries/servers';
import { federationInstances } from '../../db/schema';
import { invalidateCorsCache } from '../../http/cors';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const removeInstanceRoute = protectedProcedure
  .input(
    z.object({
      instanceId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const server = await getFirstServer();
    await ctx.needsPermission(Permission.MANAGE_SETTINGS, server?.id);

    // Look up domain before deleting so we can include it in the event
    const instance = await getFederationInstanceById(input.instanceId);

    // Delete shadow users from this instance
    await deleteShadowUsersByInstance(input.instanceId);

    // Delete the instance record
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
