import { db } from '../../db';
import { federationInstances, userFederatedServers } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { protectedProcedure } from '../../utils/trpc';

const getJoinedRoute = protectedProcedure.query(async ({ ctx }) => {
  const rows = await db
    .select({
      instanceDomain: federationInstances.domain,
      instanceName: federationInstances.name,
      remoteServerId: userFederatedServers.remoteServerId,
      remoteServerPublicId: userFederatedServers.remoteServerPublicId,
      remoteServerName: userFederatedServers.remoteServerName
    })
    .from(userFederatedServers)
    .innerJoin(
      federationInstances,
      eq(userFederatedServers.instanceId, federationInstances.id)
    )
    .where(
      and(
        eq(userFederatedServers.userId, ctx.userId),
        eq(federationInstances.status, 'active')
      )
    );

  return rows;
});

export { getJoinedRoute };
