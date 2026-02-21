import z from 'zod';
import { db } from '../../db';
import { federationInstances, userFederatedServers } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { protectedProcedure } from '../../utils/trpc';

const leaveRemoteRoute = protectedProcedure
  .input(
    z.object({
      instanceDomain: z.string(),
      remoteServerId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [instance] = await db
      .select({ id: federationInstances.id })
      .from(federationInstances)
      .where(eq(federationInstances.domain, input.instanceDomain))
      .limit(1);

    if (!instance) return;

    await db
      .delete(userFederatedServers)
      .where(
        and(
          eq(userFederatedServers.userId, ctx.userId),
          eq(userFederatedServers.instanceId, instance.id),
          eq(userFederatedServers.remoteServerId, input.remoteServerId)
        )
      );
  });

export { leaveRemoteRoute };
